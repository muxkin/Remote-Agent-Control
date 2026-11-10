use crate::{codex::History, files, state::private_file};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};
use url::Url;
use uuid::Uuid;

const LIMIT: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_LINE: u64 = 32 * 1024 * 1024;
const INLINE_LIMIT: usize = 24 * 1024 * 1024;
const MAX_VIEWED_IMAGES: usize = 32;

#[derive(Debug)]
pub struct MissingAttachment;

impl std::fmt::Display for MissingAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("原附件文件已不可用，且没有可恢复的数据，请在电脑端重新发送。")
    }
}

impl std::error::Error for MissingAttachment {}

#[derive(Default, Clone)]
pub struct Rollouts(Arc<Mutex<HashMap<PathBuf, Expanded>>>);

struct Expanded {
    file: tempfile::NamedTempFile,
    modified: SystemTime,
    compressed: u64,
    size: u64,
}

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

pub fn description(
    history: &History,
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
        if let Some(source) = legacy_upload(path, thread, device)? {
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
            match project_file(path, history.home(), &cwd) {
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
                match project_file(path, history.home(), &cwd) {
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
                match project_file(requested.as_ref().unwrap(), history.home(), &cwd) {
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

fn legacy_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("POCKET_NATIVE_LEGACY_STATE") {
        let root = PathBuf::from(root);
        return root.is_absolute().then_some(root);
    }
    if cfg!(target_os = "linux") {
        dirs::state_dir().map(|dir| dir.join("codex-pocket-remote"))
    } else {
        dirs::data_local_dir().map(|dir| dir.join("codex-pocket-remote"))
    }
}

fn legacy_upload(path: &Path, thread: Uuid, device: &str) -> Result<Option<Source>> {
    let Some(root) = legacy_root()
        .map(|root| root.join("uploads"))
        .filter(|root| path.starts_with(root))
    else {
        return Ok(None);
    };
    let (id, name) = path
        .strip_prefix(&root)?
        .components()
        .next()
        .and_then(|component| {
            Some((
                Uuid::parse_str(component.as_os_str().to_str()?).ok()?,
                path.file_name()?.to_str()?,
            ))
        })
        .context("旧附件路径无效")?;
    ensure!(
        path == root.join(id.to_string()).join(name)
            && path.canonicalize()? == root.canonicalize()?.join(id.to_string()).join(name),
        "旧附件路径无效"
    );
    let metadata = root.join(format!("{id}.json"));
    let metadata: Value = serde_json::from_reader(private_file(&metadata, false)?.take(64 * 1024))?;
    ensure!(
        metadata["id"] == id.to_string()
            && metadata["complete"] == true
            && metadata["thread"] == thread.to_string()
            && metadata["device"] == device
            && metadata["name"] == name
            && metadata["file"]
                .as_str()
                .is_some_and(|file| Path::new(file) == path),
        "旧附件不属于此会话和设备"
    );
    let expected = (
        metadata["size"].as_u64().context("旧附件尺寸缺失")?,
        metadata["sha256"]
            .as_str()
            .context("旧附件摘要缺失")?
            .to_owned(),
    );
    Ok(Some(Source {
        file: private_file(path, false)?,
        name: name.to_owned(),
        expected: Some(expected),
    }))
}

fn project_file(path: &Path, home: &Path, cwd: &Path) -> Result<Source> {
    let canonical = path.canonicalize()?;
    let allowed = |root: &Path| {
        root.parent().is_some()
            && path.starts_with(root)
            && root
                .canonicalize()
                .is_ok_and(|root| canonical.starts_with(&root) && canonical != root)
    };
    let media_root = ["generated_images", "artifacts", "visualizations"]
        .into_iter()
        .any(|dir| allowed(&home.join(dir)));
    ensure!(
        allowed(cwd) || media_root,
        "附件不在会话工作区或桌面媒体目录"
    );
    ensure!(
        media_root
            || canonical.components().all(|part| {
                let value = part.as_os_str().to_string_lossy().to_ascii_lowercase();
                !matches!(
                    value.as_str(),
                    ".git" | ".ssh" | ".config" | ".local" | ".codex" | "auth.json" | ".env"
                ) && !value.starts_with(".env.")
            }),
        "此文件不能通过附件入口读取"
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

fn links(text: &str) -> impl Iterator<Item = String> {
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

pub fn attachments(explicit: Vec<Value>, content: &Value) -> Vec<Value> {
    collect_attachments(explicit, media(content), |_, _| {})
}

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
