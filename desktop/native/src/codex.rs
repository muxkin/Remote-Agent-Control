use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const PAGE_SIZE: usize = 30;
const HISTORY_BYTES: u64 = 512 * 1024;
const VISIBLE: &str =
    "archived=0 AND (thread_source IN ('user','agent_created_thread') OR thread_source IS NULL)";
const PROJECT: &str = "COALESCE(threads.project_id,assignment.value)";
const PROJECT_JOIN: &str = "LEFT JOIN json_each(?1) assignment ON assignment.key=threads.id";
const FIELDS: &str = "threads.id,COALESCE(name,title),cwd,updated_at_ms,COALESCE(threads.project_id,assignment.value)";

#[derive(Clone)]
pub struct History {
    home: PathBuf,
    host_key: String,
    queued: Arc<Mutex<Option<QueueFile>>>,
    rollouts: crate::history_media::Rollouts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    title: String,
    cwd: String,
    updated_at: i64,
    project_id: Option<String>,
    project_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    time: i64,
    id: String,
}

struct QueueFile {
    modified: SystemTime,
    length: u64,
    rows: Value,
}

struct ProjectIndex {
    names: HashMap<String, String>,
    order: Vec<String>,
    memberships: String,
}

impl History {
    pub fn open(home: &Path) -> Result<Self> {
        let history = Self {
            home: home.canonicalize()?,
            host_key: format!("local:{}", std::path::absolute(home)?.display()),
            queued: Default::default(),
            rollouts: Default::default(),
        };
        history.database()?.prepare(&format!(
            "SELECT {FIELDS},rollout_path FROM threads {PROJECT_JOIN} WHERE {VISIBLE} LIMIT 0"
        ))?;
        Ok(history)
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    fn database(&self) -> Result<Connection> {
        let db = Connection::open_with_flags(
            self.home.join("state_5.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.busy_timeout(Duration::from_millis(500))?;
        Ok(db)
    }

    pub fn latest_thread(&self) -> Result<Option<Uuid>> {
        let id: Option<String> = self
            .database()?
            .query_row(
                &format!(
                    "SELECT id FROM threads WHERE {VISIBLE} ORDER BY updated_at_ms DESC LIMIT 1"
                ),
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(id.and_then(|id| Uuid::parse_str(&id).ok()))
    }

    pub fn anchor(&self, thread: &str) -> Result<String> {
        if thread == "new" {
            return Ok(self
                .latest_thread()?
                .map_or_else(|| "new".into(), |id| id.to_string()));
        }
        let id = Uuid::parse_str(thread)?.to_string();
        let exists: bool = self.database()?.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND {VISIBLE})"),
            [&id],
            |row| row.get(0),
        )?;
        ensure!(exists, "找不到会话");
        Ok(id)
    }

    pub fn tools(&self, id: Uuid, disabled: &[String]) -> Result<crate::tools_catalog::Catalog> {
        let cwd: String = self.database()?.query_row(
            &format!("SELECT cwd FROM threads WHERE id=?1 AND {VISIBLE}"),
            [id.to_string()],
            |row| row.get(0),
        )?;
        crate::tools_catalog::Catalog::scan(&self.home, Path::new(&cwd), disabled)
    }

    fn global_state(&self) -> Result<Value> {
        match fs::read(self.home.join(".codex-global-state.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(error) => Err(error.into()),
        }
    }

    pub fn native_queue(&self, thread: Uuid) -> Result<Vec<Value>> {
        let path = self.home.join(".codex-global-state.json");
        let info = path.metadata()?;
        let modified = info.modified()?;
        ensure!(info.len() <= 32 * 1024 * 1024, "桌面队列文件过大");
        let mut cached = self.queued.lock().expect("queue mutex poisoned");
        if cached
            .as_ref()
            .is_none_or(|old| old.modified != modified || old.length != info.len())
        {
            let mut file = File::open(path)?;
            let mut data = Vec::with_capacity(info.len() as usize);
            (&mut file)
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut data)?;
            ensure!(data.len() <= 32 * 1024 * 1024, "桌面队列文件过大");
            let mut value: Value = serde_json::from_slice(&data)?;
            let rows = value["queued-follow-ups"].take();
            ensure!(rows.is_object(), "此桌面版本未提供原生队列");
            *cached = Some(QueueFile {
                modified,
                length: info.len(),
                rows,
            });
        }
        let value = &cached.as_ref().unwrap().rows[&thread.to_string()];
        if value.is_null() {
            Ok(Vec::new())
        } else {
            value.as_array().cloned().context("桌面队列格式无效")
        }
    }

    pub fn project_aliases(&self) -> Result<Value> {
        let mut state = self.global_state()?;
        Ok(state["app-server-project-id-by-legacy-project-id-by-host"][&self.host_key].take())
    }

    pub fn models(&self) -> Result<Value> {
        let data: Value = match fs::read(self.home.join("models_cache.codex_work_desktop.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
            Err(error) => return Err(error.into()),
        };
        let models: Vec<_> = data["models"].as_array().into_iter().flatten()
            .filter(|model| model["visibility"] == "list")
            .filter_map(|model| {
                let id = model["slug"].as_str()?;
                let efforts: Vec<_> = model["supported_reasoning_levels"].as_array().into_iter().flatten()
                    .filter_map(|level| level["effort"].as_str()).collect();
                let mut speeds = vec![json!({"id":"default","name":"标准","description":"标准速度与用量"})];
                speeds.extend(model["service_tiers"].as_array().into_iter().flatten().filter_map(|tier| {
                    let id = tier["id"].as_str().filter(|id| *id != "default")?;
                    Some(json!({"id":id,"name":tier["name"].as_str().unwrap_or(id),"description":tier["description"].as_str().unwrap_or("")}))
                }));
                Some(json!({"id":id,"name":model["display_name"].as_str().unwrap_or(id),
                    "efforts":efforts,"defaultEffort":model["default_reasoning_level"],"speeds":speeds}))
            }).collect();
        Ok(json!({"models":models,"fetchedAt":data["fetched_at"],"source":"desktop-cache"}))
    }

    pub fn rpc(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        match method {
            "models.list" => self.models().map(Some),
            "threads.list" => self.threads(query).map(Some),
            "projects.list" => self.projects().map(Some),
            "thread.read" | "history.read" => {
                let id = params["id"].as_str().context("会话 ID 无效")?;
                let db = self.database()?;
                let projects = self.project_index(&db)?;
                let Some((thread, path)) = db.query_row(
                    &format!("SELECT {FIELDS},rollout_path FROM threads {PROJECT_JOIN} WHERE threads.id=?2 AND {VISIBLE}"),
                    params![projects.memberships, id],
                    |row| Ok((read_thread(row, &projects.names)?, row.get::<_, String>(5)?)),
                ).optional()? else { return Ok(None); };
                if method == "thread.read" {
                    return Ok(Some(json!({"thread": thread})));
                }
                let page = self.read_page(Path::new(&path), query["cursor"].as_str())?;
                Ok(Some(
                    json!({"thread": thread, "messages": page.0, "nextCursor": page.1}),
                ))
            }
            _ => Ok(None),
        }
    }

    fn threads(&self, query: &Value) -> Result<Value> {
        let search = query["q"].as_str().unwrap_or("").trim();
        let project = query["project"].as_str();
        ensure!(search.encode_utf16().count() <= 120, "搜索过长");
        let cursor = query["cursor"]
            .as_str()
            .map(|value| {
                ensure!(value.len() <= 1024, "游标过长");
                Ok::<Cursor, anyhow::Error>(serde_json::from_slice(
                    &URL_SAFE_NO_PAD.decode(value)?,
                )?)
            })
            .transpose()?;
        let db = self.database()?;
        let projects = self.project_index(&db)?;
        let lower = search.to_lowercase();
        let matching: Vec<_> = projects
            .names
            .iter()
            .filter(|(_, name)| name.to_lowercase().contains(&lower))
            .map(|(id, _)| id)
            .collect();
        let mut stmt = db.prepare(&format!(
            "SELECT {FIELDS} FROM threads {PROJECT_JOIN} WHERE {VISIBLE}
             AND (?2 IS NULL OR (?2='none' AND {PROJECT} IS NULL) OR {PROJECT}=?2)
             AND (?3='' OR instr(lower(COALESCE(name,title)), lower(?3))>0 OR {PROJECT} IN (SELECT value FROM json_each(?4)))
             AND (?5 IS NULL OR updated_at_ms<?5 OR (updated_at_ms=?5 AND threads.id<?6))
             ORDER BY updated_at_ms DESC,threads.id DESC LIMIT ?7"
        ))?;
        let mut threads = stmt
            .query_map(
                params![
                    projects.memberships,
                    project,
                    search,
                    serde_json::to_string(&matching)?,
                    cursor.as_ref().map(|c| c.time),
                    cursor.as_ref().map(|c| &c.id),
                    PAGE_SIZE as i64 + 1,
                ],
                |row| read_thread(row, &projects.names),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if threads.len() > PAGE_SIZE {
            threads.truncate(PAGE_SIZE);
            let last = &threads[PAGE_SIZE - 1];
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
                time: last.updated_at,
                id: last.id.clone(),
            })?))
        } else {
            None
        };
        Ok(json!({"threads": threads, "nextCursor": next}))
    }

    fn project_index(&self, db: &Connection) -> Result<ProjectIndex> {
        let mut stmt = db.prepare("SELECT id,name FROM projects ORDER BY position,id")?;
        let native = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut order: Vec<_> = native.iter().map(|(id, _)| id.clone()).collect();
        let mut names: HashMap<_, _> = native.into_iter().collect();
        let state = self.global_state()?;
        let aliases = &state["app-server-project-id-by-legacy-project-id-by-host"][&self.host_key];
        let canonical = |id: &str| aliases[id].as_str().unwrap_or(id).to_owned();
        if let Some(legacy) = state["local-projects"].as_object() {
            for project in legacy.values() {
                if let (Some(id), Some(name)) = (project["id"].as_str(), project["name"].as_str()) {
                    let id = canonical(id);
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        names.entry(id.clone())
                    {
                        order.push(id);
                        entry.insert(name.to_owned());
                    }
                }
            }
        }
        let projectless: HashSet<_> = state["projectless-thread-ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let memberships: HashMap<_, _> = state["thread-project-assignments"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(thread, assignment)| {
                let id = canonical(assignment["projectId"].as_str()?);
                (!projectless.contains(thread.as_str())
                    && assignment["projectKind"] == "local"
                    && names.contains_key(&id))
                .then_some((thread, id))
            })
            .collect();
        Ok(ProjectIndex {
            names,
            order,
            memberships: serde_json::to_string(&memberships)?,
        })
    }

    fn projects(&self) -> Result<Value> {
        let db = self.database()?;
        let index = self.project_index(&db)?;
        let mut stmt = db.prepare(&format!(
            "SELECT {PROJECT},COUNT(*) FROM threads {PROJECT_JOIN} WHERE {VISIBLE} GROUP BY {PROJECT}"
        ))?;
        let counts: HashMap<Option<String>, i64> = stmt
            .query_map([index.memberships], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let projects: Vec<_> = index.order.iter().map(|id| json!({
            "id": id, "name": index.names[id], "count": counts.get(&Some(id.clone())).copied().unwrap_or_default()
        })).collect();
        Ok(
            json!({"projects":projects,"total":counts.values().sum::<i64>(),"ungrouped":counts.get(&None).copied().unwrap_or_default()}),
        )
    }

    pub fn media_context(&self, thread: Uuid) -> Result<(PathBuf, PathBuf)> {
        Ok(self.database()?.query_row(
            &format!("SELECT cwd,rollout_path FROM threads WHERE id=?1 AND {VISIBLE}"),
            [thread.to_string()],
            |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            },
        )?)
    }

    pub fn open_rollout(&self, path: &Path) -> Result<File> {
        let path = path.canonicalize().context("会话记录无法读取")?;
        let allowed = ["sessions", "archived_sessions"].iter().any(|root| {
            let directory = self.home.join(root);
            directory
                .canonicalize()
                .is_ok_and(|resolved| resolved == directory && path.starts_with(resolved))
        });
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        ensure!(
            allowed && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")),
            "会话记录路径无效"
        );
        self.rollouts.open(&path)
    }

    pub fn content(&self, id: Uuid, message_id: &str) -> Result<Option<Value>> {
        let Some(offset) = message_id
            .strip_prefix("rollout-")
            .and_then(|offset| offset.parse::<u64>().ok())
        else {
            return Ok(None);
        };
        let (_, path) = self.media_context(id)?;
        let mut file = self.open_rollout(&path)?;
        ensure!(offset < file.metadata()?.len(), "消息偏移无效");
        if offset > 0 {
            file.seek(SeekFrom::Start(offset - 1))?;
            let mut before = [0];
            file.read_exact(&mut before)?;
            ensure!(before == [b'\n'], "消息偏移无效");
        }
        let mut line = Vec::new();
        BufReader::new(file)
            .take(crate::history_media::MAX_LINE)
            .read_until(b'\n', &mut line)?;
        if line.last() != Some(&b'\n') {
            return Ok(None);
        }
        Ok(rollout_message(&line, offset, true)
            .filter(|message| message["id"] == message_id)
            .map(|message| json!({"message":message})))
    }

    fn read_page(&self, path: &Path, cursor: Option<&str>) -> Result<(Vec<Value>, Option<String>)> {
        let mut file = self.open_rollout(path)?;
        let length = file.metadata()?.len();
        let end = cursor.map(str::parse::<u64>).transpose()?.unwrap_or(length);
        ensure!(end <= length, "历史游标已失效");
        let mut window = HISTORY_BYTES;
        let (start, bytes, first) = loop {
            let start = end.saturating_sub(window);
            file.seek(SeekFrom::Start(start.saturating_sub(1)))?;
            let mut bytes = Vec::with_capacity((end - start + 1) as usize);
            (&mut file)
                .take(end - start.saturating_sub(1))
                .read_to_end(&mut bytes)?;
            let first = if start == 0 {
                0
            } else {
                bytes
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(bytes.len(), |position| position + 1)
            };
            // Large inline media can occupy a full window. Parse one bounded record
            // while keeping its base64 bytes out of the returned messages.
            if start == 0 || first < bytes.len() || window >= crate::history_media::MAX_LINE {
                break (start, bytes, first);
            }
            window = (window * 2).min(crate::history_media::MAX_LINE);
        };
        let mut offset = start.saturating_sub(1) + first as u64;
        let mut messages = Vec::new();
        for line in bytes[first..].split_inclusive(|byte| *byte == b'\n') {
            if line.ends_with(b"\n") {
                if let Some(message) = rollout_message(line, offset, false) {
                    messages.push((offset, message));
                }
            }
            offset += line.len() as u64;
        }
        let skipped = messages.len().saturating_sub(100);
        let next = if skipped > 0 {
            Some(messages[skipped].0.to_string())
        } else {
            (start > 0).then(|| {
                let boundary = start.saturating_sub(1) + first as u64;
                // A single large record can span the entire window. Skip it without looping.
                if boundary >= end {
                    start.to_string()
                } else {
                    boundary.to_string()
                }
            })
        };
        Ok((
            messages
                .into_iter()
                .skip(skipped)
                .map(|(_, message)| message)
                .collect(),
            next,
        ))
    }
}

fn read_thread(row: &Row<'_>, names: &HashMap<String, String>) -> rusqlite::Result<Thread> {
    let project_id: Option<String> = row.get(4)?;
    let project_name = project_id.as_ref().and_then(|id| names.get(id)).cloned();
    Ok(Thread {
        id: row.get(0)?,
        title: row.get(1)?,
        cwd: row.get(2)?,
        updated_at: row.get(3)?,
        project_id,
        project_name,
    })
}

fn rollout_message(line: &[u8], offset: u64, full: bool) -> Option<Value> {
    let record: Value = serde_json::from_slice(line).ok()?;
    let message = &record["payload"];
    if record["type"] != "response_item" {
        return None;
    }
    let role = message["role"].as_str().unwrap_or_default();
    if message["type"] != "message" || !matches!(role, "user" | "assistant") {
        let attachments = crate::history_media::attachments(Vec::new(), message);
        return (!attachments.is_empty()).then(|| {
            json!({"id":format!("rollout-{offset}:media:0"),
            "role":"assistant","text":"","attachments":attachments})
        });
    }
    let text = crate::codex_live::native_text(&message["content"]);
    if role == "user" && text.trim_start().starts_with("<environment_context>") {
        return None;
    }
    let (text, explicit) = if role == "user" {
        let (text, explicit) = crate::files::message_attachment_text(&text);
        (crate::requests::display_reply(text), explicit)
    } else {
        (text, Vec::new())
    };
    let attachments = crate::history_media::attachments(explicit, message);
    let mut text = text;
    let limit = 2 * 1024 * 1024;
    if full && text.len() > limit {
        return None;
    }
    let truncated = !full && text.len() > 12_000 && text.len() <= limit;
    if !full && text.len() > 12_000 {
        let too_large = text.len() > limit;
        text.truncate(text.floor_char_boundary(12_000));
        if too_large {
            text.push_str("\n请在桌面查看完整内容。");
        }
    }
    (!text.is_empty() || !attachments.is_empty()).then(|| {
        json!({"id":format!("rollout-{offset}"),"role":role,"text":text,
            "attachments":attachments,"truncated":truncated})
    })
}
