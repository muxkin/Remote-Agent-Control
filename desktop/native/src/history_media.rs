#[cfg(feature = "official-plugins")]
use crate::codex::History;
use crate::{
    files,
    state::{hash, legacy_private_file, private_file},
};
#[cfg(feature = "official-plugins")]
use anyhow::bail;
use anyhow::{Context, Result, ensure};
#[cfg(feature = "official-plugins")]
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(feature = "official-plugins")]
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
#[cfg(feature = "official-plugins")]
use regex::Regex;
use serde_json::{Value, json};
#[cfg(feature = "official-plugins")]
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
#[cfg(feature = "official-plugins")]
use url::Url;
use uuid::Uuid;

#[cfg(feature = "official-plugins")]
const LIMIT: u64 = 512 * 1024 * 1024;
#[cfg(feature = "official-plugins")]
pub(crate) const MAX_LINE: u64 = 32 * 1024 * 1024;
#[cfg(feature = "official-plugins")]
const INLINE_LIMIT: usize = 24 * 1024 * 1024;
#[cfg(feature = "official-plugins")]
const MAX_VIEWED_IMAGES: usize = 32;

#[derive(Debug)]
pub struct MissingAttachment;

impl std::fmt::Display for MissingAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("原附件文件已不可用，且没有可恢复的数据，请在电脑端重新发送。")
    }
}

impl std::error::Error for MissingAttachment {}

#[derive(Debug)]
pub(crate) struct HistoryUnavailable;

impl std::fmt::Display for HistoryUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("无法读取本机历史记录，请在 Codex 桌面打开此会话确认记录是否可用。")
    }
}

impl std::error::Error for HistoryUnavailable {}

#[cfg(feature = "official-plugins")]
#[derive(Default, Clone)]
pub struct Rollouts(Arc<Mutex<HashMap<PathBuf, Expanded>>>);

#[cfg(feature = "official-plugins")]
struct Expanded {
    file: tempfile::NamedTempFile,
    modified: SystemTime,
    compressed: u64,
    size: u64,
}

#[cfg(feature = "official-plugins")]
impl Rollouts {
    pub fn open(&self, path: &Path) -> Result<File> {
        let file = File::open(path)?;
        ensure!(file.metadata()?.is_file(), "会话记录不是普通文件");
        if path.extension().is_none_or(|ext| ext != "zst") {
            return Ok(file);
        }
        let metadata = file.metadata()?;
        let modified = metadata.modified()?;
        let compressed = metadata.len();
        let mut cache = self.0.lock().expect("rollout cache poisoned");
        if let Some(entry) = cache
            .get(path)
            .filter(|entry| entry.modified == modified && entry.compressed == compressed)
        {
            let mut reopened = entry.file.reopen()?;
            reopened.seek(SeekFrom::Start(0))?;
            return Ok(reopened);
        }
        cache.remove(path);
        let mut decoder = zstd::stream::read::Decoder::new(file)?;
        decoder.window_log_max(27)?;
        let mut output = tempfile::NamedTempFile::new()?;
        let size = std::io::copy(&mut decoder.take(LIMIT + 1), &mut output)?;
        ensure!(size <= LIMIT, "会话记录解压后超过 512 MiB");
        let current = path.metadata()?;
        ensure!(
            current.modified()? == modified && current.len() == compressed,
            "会话记录已更新"
        );
        if cache.len() >= 4 || cache.values().map(|entry| entry.size).sum::<u64>() + size > LIMIT {
            cache.clear();
        }
        output.seek(SeekFrom::Start(0))?;
        let reader = output.reopen()?;
        cache.insert(
            path.to_owned(),
            Expanded {
                file: output,
                modified,
                compressed,
                size,
            },
        );
        Ok(reader)
    }
}

pub struct Source {
    pub file: File,
    pub name: String,
    pub expected: Option<(u64, String)>,
}

#[cfg(feature = "official-plugins")]
pub fn description(
    history: &History,
    backend: &str,
    thread: Uuid,
    device: &str,
    reference: &str,
    live: Option<&crate::codex_live::View>,
) -> Result<Source> {
    let (cwd, log) = history.media_context(thread)?;
    let inline = reference
        .strip_prefix("pocket-inline:")
        .is_some_and(|token| {
            token.split_once('.').is_some_and(|(digest, ext)| {
                digest.len() == 64
                    && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && ext.len() <= 5
                    && ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        });
    let requested = if inline {
        None
    } else {
        Some(local_path(reference, &cwd)?)
    };
    if let Some(path) = &requested {
        if let Some(source) = legacy_upload(path, backend, &thread.to_string(), device)? {
            return Ok(source);
        }
        ensure!(
            !path
                .components()
                .any(|part| part.as_os_str() == "native-uploads"),
            "此附件属于其他设备或会话"
        );
    }

    let link_matches = |link: &str| {
        requested
            .as_ref()
            .is_some_and(|path| local_path(link, &cwd).is_ok_and(|link| &link == path))
    };
    let mut missing = false;
    if let Some(view) = live {
        if inline && let Some(data) = view.inline.get(reference) {
            return embedded(data);
        }
        if let Some(path) = &requested
            && view.messages.iter().any(|message| {
                let text = message["id"]
                    .as_str()
                    .and_then(|id| view.expanded.get(id))
                    .map(String::as_str)
                    .or_else(|| message["text"].as_str())
                    .unwrap_or_default();
                message["attachments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|item| item["path"].as_str().is_some_and(link_matches))
                    || (message["role"] == "assistant"
                        && links(text).any(|link| link_matches(&link)))
            })
        {
            match attachment_file(path) {
                Ok(source) => return Ok(source),
                Err(error) => missing |= is_not_found(&error),
            }
        }
    }

    let mut calls: HashMap<String, (Vec<String>, bool)> = HashMap::new();
    let file = history.open_rollout(&log)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        if (&mut reader).take(MAX_LINE).read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.len() as u64 == MAX_LINE && line.last() != Some(&b'\n') {
            reader.skip_until(b'\n')?;
            calls.clear();
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            calls.clear();
            continue;
        };
        let p = &record["payload"];
        if record["type"] == "turn_context"
            || (record["type"] == "event_msg"
                && matches!(p["type"].as_str(), Some("task_started" | "task_complete")))
        {
            calls.clear();
        }
        if record["type"] == "response_item" {
            if inline {
                if let Some(data) = media(p)
                    .into_iter()
                    .find(|source| media_reference(source) == reference)
                {
                    return embedded(&data);
                }
                continue;
            }
            let path = requested.as_ref().unwrap();
            let text = crate::codex_live::native_text(&p["content"]);
            let (_, attachments) = files::message_attachment_text(&text);
            if media(p).iter().any(|source| link_matches(source))
                || (p["type"] == "message"
                    && p["role"] == "assistant"
                    && links(&text).any(|link| link_matches(&link)))
                || (p["type"] == "message"
                    && p["role"] == "user"
                    && attachments
                        .iter()
                        .any(|item| item["path"].as_str().is_some_and(link_matches)))
            {
                match attachment_file(path) {
                    Ok(source) => return Ok(source),
                    Err(error) => missing |= is_not_found(&error),
                }
            }
            let call = p["call_id"].as_str();
            if let Some(call) = call
                && matches!(
                    p["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                )
            {
                if calls.len() >= 64 {
                    calls.clear();
                }
                for entry in calls.values_mut() {
                    entry.1 = true;
                }
                let ambiguous = !calls.is_empty();
                calls.insert(call.to_owned(), (Vec::new(), ambiguous));
            } else if let Some(call) = call
                && matches!(
                    p["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
                && let Some((paths, false)) = calls.remove(call)
            {
                let mut matches = paths
                    .iter()
                    .enumerate()
                    .filter(|(_, path)| link_matches(path));
                if let Some((index, _)) = matches.next()
                    && matches.next().is_none()
                {
                    // A single exec can emit several ImageView events. Match its own
                    // image results in order only when the association is complete.
                    if let Some(images) = viewed_images(&p["output"])
                        && images.len() == paths.len()
                        && let Ok(source) = embedded(images[index])
                    {
                        return Ok(source);
                    }
                }
            }
        } else if !inline
            && record["type"] == "event_msg"
            && p["type"] == "item_completed"
            && p["item"]["type"] == "ImageView"
            && let Some(path) = p["item"]["path"].as_str()
        {
            let own_thread = p["thread_id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                == Some(thread);
            if own_thread && link_matches(path) {
                match attachment_file(requested.as_ref().unwrap()) {
                    Ok(source) => return Ok(source),
                    Err(_) => missing = true,
                }
            }
            if calls.len() == 1
                && let Some((paths, ambiguous)) = calls.values_mut().next()
            {
                if own_thread && paths.len() < MAX_VIEWED_IMAGES {
                    paths.push(path.to_owned());
                } else {
                    *ambiguous = true;
                }
            }
        }
    }
    if missing {
        return Err(MissingAttachment.into());
    }
    bail!("文件未作为可读取附件出现在当前会话")
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(feature = "official-plugins")]
fn viewed_images(output: &Value) -> Option<Vec<&str>> {
    let mut images = Vec::new();
    for item in output.as_array()? {
        match item["type"].as_str()? {
            "text" | "input_text" | "output_text" => {}
            "input_image" | "image_url" => {
                let image = item["image_url"]
                    .as_str()
                    .or_else(|| item["image_url"]["url"].as_str())?;
                let (kind, _) = image.strip_prefix("data:")?.split_once(";base64,")?;
                if !kind.starts_with("image/")
                    || extension(kind).is_none()
                    || image.len() > INLINE_LIMIT
                    || images.len() == MAX_VIEWED_IMAGES
                {
                    return None;
                }
                images.push(image);
            }
            _ => return None,
        }
    }
    Some(images)
}

pub(crate) fn legacy_root() -> Option<PathBuf> {
    if let Some(root) = crate::migration::source() {
        return Some(root.to_owned());
    }
    // Official plugin processes receive the selected legacy directory from the gateway.
    if let Some(root) = std::env::var_os("POCKET_NATIVE_LEGACY_STATE").map(PathBuf::from) {
        return root.is_absolute().then_some(root);
    }
    if cfg!(target_os = "linux") {
        dirs::state_dir().map(|dir| dir.join("codex-pocket-remote"))
    } else {
        dirs::data_local_dir().map(|dir| dir.join("codex-pocket-remote"))
    }
}

pub(crate) fn legacy_dsh_file(backend: &str, thread: &str, attachment_id: &str) -> Result<File> {
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

pub(crate) fn dsh_attachment_digest(id: &str) -> Option<&str> {
    let digest = id.strip_prefix("sha256:").unwrap_or(id);
    (digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(digest)
}

pub(crate) fn legacy_upload(
    path: &Path,
    backend: &str,
    thread: &str,
    device: &str,
) -> Result<Option<Source>> {
    let Some(state) = legacy_root() else {
        return Ok(None);
    };
    let root = legacy_upload_dir(&state, backend);
    if !path.starts_with(&root) {
        let is_upload = |path: &Path, state: &Path| {
            let Ok(relative) = path.strip_prefix(state) else {
                return false;
            };
            let mut parts = relative.components().map(|part| part.as_os_str());
            match parts.next().and_then(|part| part.to_str()) {
                Some("uploads") => true,
                Some("backends") => {
                    parts.next().is_some() && parts.next().is_some_and(|part| part == "uploads")
                }
                _ => false,
            }
        };
        ensure!(
            !is_upload(path, &state)
                && !state
                    .canonicalize()
                    .ok()
                    .zip(path.canonicalize().ok())
                    .is_some_and(|(state, path)| is_upload(&path, &state)),
            "旧附件不属于此实例"
        );
        return Ok(None);
    }
    let id = path
        .strip_prefix(&root)?
        .components()
        .next()
        .and_then(|component| Uuid::parse_str(component.as_os_str().to_str()?).ok())
        .context("旧附件路径无效")?;
    let (upload, file) =
        open_legacy_upload(&root, thread, device, id)?.context(MissingAttachment)?;
    ensure!(upload.path == path, "旧附件路径无效");
    Ok(Some(Source {
        file,
        name: upload.name,
        expected: Some((upload.size, upload.sha256)),
    }))
}

pub(crate) fn legacy_upload_id(
    backend: &str,
    thread: &str,
    device: &str,
    id: Uuid,
) -> Result<Option<files::VerifiedUpload>> {
    let Some(state) = legacy_root() else {
        return Ok(None);
    };
    let root = legacy_upload_dir(&state, backend);
    Ok(open_legacy_upload(&root, thread, device, id)?.map(|(upload, _)| upload))
}

fn legacy_upload_dir(state: &Path, backend: &str) -> PathBuf {
    if backend == crate::codex_backend::ID {
        state.join("uploads")
    } else {
        state.join("backends").join(backend).join("uploads")
    }
}

fn open_legacy_upload(
    root: &Path,
    thread: &str,
    device: &str,
    id: Uuid,
) -> Result<Option<(files::VerifiedUpload, File)>> {
    let Some(receipt) = read_legacy_upload(root, thread, device, id)? else {
        return Ok(None);
    };
    ensure!(receipt.complete, "旧附件尚未传完");
    let file = receipt.open(false)?;
    ensure!(
        file.metadata()?.len() == receipt.upload.size,
        "旧附件大小校验失败"
    );
    Ok(Some((receipt.upload, file)))
}

pub(crate) struct LegacyUpload {
    pub(crate) upload: files::VerifiedUpload,
    pub(crate) complete: bool,
    pub(crate) expires: i64,
    pub(crate) offset: u64,
    root: PathBuf,
}

impl LegacyUpload {
    pub(crate) fn part_path(&self) -> PathBuf {
        let mut path = self.upload.path.as_os_str().to_owned();
        path.push(".part");
        path.into()
    }

    pub(crate) fn open(&self, partial: bool) -> Result<File> {
        let path = if partial {
            self.part_path()
        } else {
            self.upload.path.clone()
        };
        let canonical = path.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                anyhow::Error::new(MissingAttachment)
            } else {
                error.into()
            }
        })?;
        ensure!(
            canonical
                == self
                    .root
                    .canonicalize()?
                    .join(path.strip_prefix(&self.root)?),
            "旧附件路径无效"
        );
        legacy_private_file(&path)
    }

    pub(crate) fn open_pending(&self) -> Result<File> {
        match self.open(true) {
            // The old uploader renamed the file before committing the completed receipt.
            Err(error) if error.is::<MissingAttachment>() => self.open(false),
            result => result,
        }
    }

    pub(crate) fn transfer(&self, id: Uuid) -> Result<Option<Value>> {
        self.transfer_record(id, "json")
    }

    pub(crate) fn storage_object(&self, id: Uuid) -> Result<Option<Value>> {
        self.transfer_record(id, "object")
    }

    fn transfer_record(&self, id: Uuid, extension: &str) -> Result<Option<Value>> {
        let directory = self
            .root
            .parent()
            .context("旧附件目录无效")?
            .join("transfers-v2");
        legacy_upload_json(&directory.join(format!("{id}.{extension}")))
    }
}

pub(crate) fn legacy_upload_receipt(
    backend: &str,
    thread: &str,
    device: &str,
    id: Uuid,
) -> Result<Option<LegacyUpload>> {
    let Some(state) = legacy_root() else {
        return Ok(None);
    };
    read_legacy_upload(&legacy_upload_dir(&state, backend), thread, device, id)
}

fn legacy_upload_json(path: &Path) -> Result<Option<Value>> {
    let receipt = match legacy_private_file(path) {
        Ok(receipt) => receipt,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    receipt.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 64 * 1024, "旧附件回执过大");
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn read_legacy_upload(
    root: &Path,
    thread: &str,
    device: &str,
    id: Uuid,
) -> Result<Option<LegacyUpload>> {
    let Some(metadata) = legacy_upload_json(&root.join(format!("{id}.json")))? else {
        return Ok(None);
    };
    let complete = metadata["complete"].as_bool().context("旧附件状态无效")?;
    let expires = metadata["expires"].as_i64().unwrap_or_default();
    ensure!(
        metadata["id"] == id.to_string()
            && metadata["thread"] == thread
            && metadata["device"] == device
            && (complete || expires > crate::state::now()),
        "旧附件不属于此会话和设备"
    );
    let name = metadata["name"]
        .as_str()
        .filter(|name| {
            (1..=200).contains(&name.encode_utf16().count())
                && !name.chars().any(|ch| {
                    ch.is_control() || matches!(ch, '/' | '\\') || (cfg!(windows) && ch == ':')
                })
                && {
                    let mut parts = Path::new(name).components();
                    matches!(parts.next(), Some(std::path::Component::Normal(_)))
                        && parts.next().is_none()
                }
        })
        .context("旧附件名称无效")?;
    let path = root.join(id.to_string()).join(name);
    ensure!(
        metadata["file"]
            .as_str()
            .is_some_and(|file| Path::new(file) == path),
        "旧附件路径无效"
    );
    let size = metadata["size"]
        .as_u64()
        .filter(|size| (1..=(256 * files::BLOCK) as u64).contains(size))
        .context("旧附件尺寸无效")?;
    let sha256 = metadata["sha256"]
        .as_str()
        .filter(|value| files::is_hash(value))
        .context("旧附件摘要无效")?;
    let offset = metadata["offset"].as_u64().unwrap_or_default();
    ensure!(offset <= size, "旧附件偏移无效");
    Ok(Some(LegacyUpload {
        upload: files::VerifiedUpload {
            name: name.to_owned(),
            path,
            size,
            sha256: sha256.to_owned(),
        },
        complete,
        expires,
        offset,
        root: root.to_owned(),
    }))
}

#[cfg(feature = "official-plugins")]
fn attachment_file(path: &Path) -> Result<Source> {
    let canonical = path.canonicalize()?;
    ensure!(
        !canonical
            .components()
            .any(|part| part.as_os_str().eq_ignore_ascii_case("native-uploads")),
        "此附件属于其他设备或会话"
    );
    ensure!(canonical.metadata()?.is_file(), "附件不是普通文件");
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("附件名无效")?
        .to_owned();
    Ok(Source {
        file: File::open(canonical)?,
        name,
        expected: None,
    })
}

#[cfg(feature = "official-plugins")]
fn local_path(reference: &str, cwd: &Path) -> Result<PathBuf> {
    let raw = reference
        .trim()
        .strip_prefix("sandbox:")
        .unwrap_or(reference.trim());
    let mut stripped = raw;
    for _ in 0..2 {
        let Some((base, number)) = stripped.rsplit_once(':') else {
            break;
        };
        if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
            stripped = base;
        } else {
            break;
        }
    }
    let path = if stripped.starts_with("file:") {
        let url = Url::parse(stripped)?;
        ensure!(
            url.host_str().is_none_or(|host| host == "localhost"),
            "只允许本机文件"
        );
        url.to_file_path()
            .map_err(|_| anyhow::anyhow!("本机文件路径无效"))?
    } else {
        let raw = percent_encoding::percent_decode_str(stripped).decode_utf8()?;
        let path = Path::new(raw.as_ref());
        ensure!(
            !raw.is_empty()
                && !raw.chars().any(char::is_control)
                && (path.is_absolute() || !raw.contains(':'))
                && !raw.starts_with("//"),
            "不是本机文件"
        );
        if path.is_absolute() {
            path.to_owned()
        } else {
            ensure!(cwd.is_absolute(), "会话没有工作目录");
            cwd.join(path)
        }
    };
    ensure!(
        path.is_absolute()
            && path
                .components()
                .all(|part| !matches!(part, std::path::Component::ParentDir)),
        "附件路径无效"
    );
    Ok(path.components().collect())
}

#[cfg(feature = "official-plugins")]
pub(crate) fn links(text: &str) -> impl Iterator<Item = String> {
    static CITATION: OnceLock<Regex> = OnceLock::new();
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    let citation =
        CITATION.get_or_init(|| Regex::new(r":{1,2}codex-file-citation\{([^\n}]*?)\}").unwrap());
    let attribute = ATTRIBUTE.get_or_init(|| {
        Regex::new(r#"([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"#).unwrap()
    });
    let mut links = Vec::new();
    let mut prose = String::new();
    let mut excluded = 0usize;
    let citations = |prose: &str, links: &mut Vec<String>| {
        for directive in citation.captures_iter(prose) {
            let mut paths = attribute
                .captures_iter(&directive[1])
                .filter(|attr| &attr[1] == "path");
            if let Some(path) = paths.next().filter(|_| paths.next().is_none()) {
                let value = &path[2][1..path[2].len() - 1];
                let value = value.replace("\\\"", "\"").replace("\\'", "'");
                if !value.chars().any(char::is_control)
                    && (Path::new(&value).is_absolute()
                        || ["file:", "sandbox:", "./"]
                            .iter()
                            .any(|prefix| value.starts_with(prefix)))
                {
                    links.push(value);
                }
            }
        }
    };
    for event in Parser::new(text) {
        match event {
            Event::Text(text) if excluded == 0 => {
                prose.push_str(&text);
                continue;
            }
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                links.push(dest_url.to_string());
                excluded += 1;
            }
            Event::Start(Tag::CodeBlock(_) | Tag::HtmlBlock) => excluded += 1,
            Event::End(TagEnd::Link | TagEnd::Image | TagEnd::CodeBlock | TagEnd::HtmlBlock) => {
                excluded = excluded.saturating_sub(1);
            }
            _ => {}
        }
        citations(&prose, &mut links);
        prose.clear();
    }
    citations(&prose, &mut links);
    links.into_iter()
}

#[cfg(feature = "official-plugins")]
pub fn media(item: &Value) -> Vec<String> {
    fn visit(item: &Value, level: u8, result: &mut Vec<String>) {
        if level > 8 || result.len() >= 32 {
            return;
        }
        if let Some(items) = item.as_array() {
            for item in items.iter().take(100) {
                visit(item, level + 1, result);
            }
            return;
        }
        if !item.is_object() {
            return;
        }
        let source = match item["type"].as_str() {
            Some("localImage" | "imageView" | "ImageView") => {
                item["path"].as_str().map(str::to_owned)
            }
            Some("imageGeneration") => ["savedPath", "src", "result"]
                .into_iter()
                .find_map(|key| item[key].as_str())
                .map(|source| {
                    if source.len() <= INLINE_LIMIT
                        && !source.contains(':')
                        && !source.starts_with('/')
                    {
                        format!("data:image/png;base64,{source}")
                    } else {
                        source.to_owned()
                    }
                }),
            Some("input_image" | "image_url") => item["image_url"]
                .as_str()
                .or_else(|| item["image_url"]["url"].as_str())
                .map(str::to_owned),
            Some("image" | "audio" | "video") => {
                item["url"].as_str().map(str::to_owned).or_else(|| {
                    let kind = item["mimeType"].as_str()?;
                    let data = item["data"].as_str()?;
                    extension(kind)?;
                    (data.len() < INLINE_LIMIT).then(|| format!("data:{kind};base64,{data}"))
                })
            }
            Some("resource_link") if item["mimeType"].as_str().and_then(extension).is_some() => {
                item["uri"].as_str().map(str::to_owned)
            }
            _ => None,
        };
        if let Some(source) = source.filter(|source| {
            !source.is_empty()
                && (source.starts_with("data:") || source.len() <= 4096)
                && source.len() <= INLINE_LIMIT
                && !result.contains(source)
        }) {
            result.push(source);
        }
        for field in [
            "content",
            "input",
            "contentItems",
            "result",
            "output",
            "toolOutput",
        ] {
            visit(&item[field], level + 1, result);
        }
    }
    let mut found = Vec::new();
    visit(item, 0, &mut found);
    found
}

#[cfg(feature = "official-plugins")]
pub fn attachments(explicit: Vec<Value>, content: &Value) -> Vec<Value> {
    collect_attachments(explicit, media(content), |_, _| {})
}

#[cfg(feature = "official-plugins")]
pub fn attachments_from(
    explicit: Vec<Value>,
    media: Vec<String>,
    inline: &mut HashMap<String, String>,
    budget: &mut usize,
) -> Vec<Value> {
    collect_attachments(explicit, media, |path, source| {
        if path.starts_with("pocket-inline:")
            && !inline.contains_key(path)
            && source.len() <= *budget
        {
            *budget -= source.len();
            inline.insert(path.to_owned(), source);
        }
    })
}

#[cfg(feature = "official-plugins")]
fn collect_attachments(
    mut explicit: Vec<Value>,
    media: Vec<String>,
    mut remember: impl FnMut(&str, String),
) -> Vec<Value> {
    for source in media {
        let path = media_reference(&source);
        if explicit.iter().any(|item| item["path"] == path) {
            continue;
        }
        let name = if path.starts_with("pocket-inline:") {
            "会话附件"
        } else {
            Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("会话附件")
        };
        explicit.push(json!({"name":name,"path":path}));
        remember(&path, source);
    }
    explicit
}

#[cfg(feature = "official-plugins")]
pub fn media_reference(source: &str) -> String {
    if let Some((kind, _)) = source
        .strip_prefix("data:")
        .and_then(|source| source.split_once(";base64,"))
        && let Some(ext) = extension(kind)
    {
        return format!("pocket-inline:{}.{}", crate::state::hash(source), ext);
    }
    source.to_owned()
}

#[cfg(feature = "official-plugins")]
fn embedded(data: &str) -> Result<Source> {
    ensure!(data.len() <= INLINE_LIMIT, "内嵌附件过大");
    let (kind, bytes) = data
        .strip_prefix("data:")
        .and_then(|data| data.split_once(";base64,"))
        .context("内嵌附件格式无效")?;
    let ext = extension(kind).context("内嵌附件类型无效")?;
    let mut file = tempfile::tempfile()?;
    file.write_all(&STANDARD.decode(bytes)?)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(Source {
        file,
        name: format!("会话附件.{ext}"),
        expected: None,
    })
}

#[cfg(feature = "official-plugins")]
fn extension(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => return None,
    })
}
