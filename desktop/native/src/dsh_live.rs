use crate::{
    dsh_settings,
    plugins::{Observation, View},
    state::hash,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use uuid::Uuid;

const MAX_TAIL_BYTES: usize = 20 * 1024 * 1024;
const MAX_STREAM_TEXT: usize = 12_000;

pub(crate) struct Timeline {
    header: Value,
    projections: Value,
    projection_cut: i64,
    projection_seq: HashMap<String, i64>,
    cursor: i64,
    records: Vec<Value>,
    durable: Durable,
    bytes: usize,
    stream_revision: i64,
    attempt: Option<Attempt>,
}

struct Durable {
    messages: Arc<[Value]>,
    observations: Arc<[Observation]>,
    turn: Option<String>,
}

impl Durable {
    fn from_records(records: &[Value]) -> Self {
        let (turn, observations) = observe(records);
        Self {
            turn,
            observations: observations.into(),
            messages: super::dsh::render(records, false).into(),
        }
    }
}

struct Attempt {
    id: String,
    turn: u64,
    step: u64,
    next: u64,
    committed: Option<i64>,
    text: BTreeMap<u64, String>,
    bytes: usize,
}

impl Attempt {
    fn parse(frame: &Value, next: u64) -> Result<Self> {
        Ok(Self {
            id: frame["attemptId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200)
                .context("DSH 流标识无效")?
                .to_owned(),
            turn: frame["turn"].as_u64().context("DSH 流回合无效")?,
            step: frame["step"].as_u64().context("DSH 流步骤无效")?,
            next,
            committed: None,
            text: BTreeMap::new(),
            bytes: 0,
        })
    }

    fn append(&mut self, index: u64, value: &str) {
        let remaining = MAX_STREAM_TEXT.saturating_sub(self.bytes);
        let part = &value[..value.floor_char_boundary(remaining.min(value.len()))];
        if !part.is_empty() {
            self.text.entry(index).or_default().push_str(part);
            self.bytes += part.len();
        }
    }

    fn chunk(&mut self, chunk: &Value) {
        if chunk["type"] == "text-delta"
            && let (Some(index), Some(text)) = (chunk["index"].as_u64(), chunk["text"].as_str())
        {
            self.append(index, text);
        }
    }

    fn restore(frame: &Value) -> Result<Self> {
        let mut attempt = Self::parse(
            frame,
            frame["nextIndex"].as_u64().context("DSH 流游标无效")?,
        )?;
        for record in frame["stream"].as_array().into_iter().flatten() {
            match record["type"].as_str() {
                Some("chunk") => attempt.chunk(&record["chunk"]),
                Some("text-chunks") => {
                    if let Some(index) = record["index"].as_u64() {
                        for fragment in record["texts"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                        {
                            attempt.append(index, fragment);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(attempt)
    }
}

impl Timeline {
    pub(crate) fn snapshot(id: &str, frame: Value, bytes: usize) -> Result<Self> {
        ensure!(
            frame["header"]["id"] == id && frame["header"]["version"] == 4,
            "不支持此 DSH 会话格式"
        );
        ensure!(bytes <= MAX_TAIL_BYTES, "DSH 历史记录过大");
        let cursor = frame["cursor"].as_i64().context("DSH 历史游标无效")?;
        let records = super::dsh::records(&frame)?.clone();
        ensure!(
            records.iter().all(|record| record["event"]["seq"]
                .as_i64()
                .is_some_and(|seq| seq >= 0 && seq <= cursor)),
            "DSH 历史记录游标无效"
        );
        let stream = &frame["assistantStream"];
        let attempt = (!stream["activeAttempt"].is_null())
            .then(|| Attempt::restore(&stream["activeAttempt"]))
            .transpose()?;
        Ok(Self {
            header: frame["header"].clone(),
            projections: frame["projections"]["values"]
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into(),
            projection_cut: frame["projections"]["asOfSeq"].as_i64().unwrap_or(cursor),
            projection_seq: HashMap::new(),
            cursor,
            durable: Durable::from_records(&records),
            records,
            bytes,
            stream_revision: stream["revision"].as_i64().unwrap_or(-1),
            attempt,
        })
    }

    pub(crate) fn advance(&mut self, thread: &str, mut frame: Value, bytes: usize) -> Result<bool> {
        match frame["type"].as_str() {
            Some("event") => {
                let event = frame["event"].take();
                let seq = event["seq"].as_i64().context("DSH 事件游标无效")?;
                if seq <= self.cursor {
                    return Ok(false);
                }
                ensure!(self.cursor.checked_add(1) == Some(seq), "DSH 事件流不连续");
                ensure!(
                    self.bytes.saturating_add(bytes) <= MAX_TAIL_BYTES && self.records.len() < 1000,
                    "DSH 需要重新读取快照"
                );
                self.cursor = seq;
                self.bytes += bytes;
                if self.attempt.as_ref().is_some_and(|attempt| {
                    attempt.committed == Some(seq)
                        || (event["type"] == "turn/end" && event["data"]["turn"] == attempt.turn)
                        || (event["type"] == "assistant/message"
                            && event["data"]["turn"] == attempt.turn
                            && event["data"]["step"] == attempt.step)
                }) {
                    self.attempt = None;
                }
                if event["type"] == "session/title"
                    && let Some(title) = event["data"]["title"].as_str()
                {
                    if !self.projections.is_object() {
                        self.projections = json!({});
                    }
                    self.projections["title"] = json!(title);
                }
                if event["type"] == "agent/inbox/spliced" {
                    self.update_inbox(&event["data"])?;
                }
                self.records.push(json!({"event":event}));
                self.durable = Durable::from_records(&self.records);
            }
            Some("assistant-stream") => {
                let chunk = &frame["frame"];
                let revision = chunk["revision"].as_i64().context("DSH 流版本无效")?;
                if revision <= self.stream_revision {
                    return Ok(false);
                }
                self.stream_revision = revision;
                if chunk["type"] == "start" {
                    self.attempt = Some(Attempt::parse(chunk, 0)?);
                } else if let Some(attempt) =
                    self.attempt.as_mut().filter(|a| chunk["attemptId"] == a.id)
                {
                    match chunk["type"].as_str() {
                        Some("chunk") => {
                            ensure!(chunk["index"] == attempt.next, "DSH 回复流不连续");
                            attempt.chunk(&chunk["chunk"]);
                            attempt.next = attempt.next.checked_add(1).context("DSH 流游标无效")?;
                        }
                        Some("end") => {
                            if chunk["outcome"]["kind"] == "committed"
                                && let Some(seq) = chunk["outcome"]["seq"]
                                    .as_i64()
                                    .filter(|seq| *seq > self.cursor)
                            {
                                attempt.committed = Some(seq);
                            } else {
                                self.attempt = None;
                            }
                        }
                        _ => return Ok(false),
                    }
                } else {
                    return Ok(false);
                }
            }
            Some("control-baseline") => {
                let baseline = &mut frame["value"]["projections"][thread];
                if baseline.is_null() {
                    return Ok(false);
                }
                let seq = baseline["asOfSeq"].as_i64().context("DSH 控制游标无效")?;
                let Some(values) = baseline["values"].as_object_mut() else {
                    return Ok(false);
                };
                let mut changed = false;
                for &key in dsh_settings::PROJECTIONS {
                    let previous = self
                        .projection_seq
                        .get(key)
                        .copied()
                        .unwrap_or(self.projection_cut);
                    if seq >= previous {
                        changed |= self.project(key, values.remove(key), seq);
                    }
                }
                self.projection_cut = self.projection_cut.max(seq);
                return Ok(changed);
            }
            Some("projection") if frame["sessionId"] == thread => {
                let Some(key) = frame["key"]
                    .as_str()
                    .filter(|key| dsh_settings::PROJECTIONS.contains(key))
                    .map(str::to_owned)
                else {
                    return Ok(false);
                };
                let seq = frame["seq"].as_i64().context("DSH 控制游标无效")?;
                if seq
                    <= self
                        .projection_seq
                        .get(&key)
                        .copied()
                        .unwrap_or(self.projection_cut)
                {
                    return Ok(false);
                }
                return Ok(self.project(&key, Some(frame["value"].take()), seq));
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn project(&mut self, key: &str, value: Option<Value>, seq: i64) -> bool {
        self.projection_seq.insert(key.to_owned(), seq);
        let map = self
            .projections
            .as_object_mut()
            .expect("DSH projections are an object");
        match value {
            Some(value) => {
                map.get(key) != Some(&value) && {
                    map.insert(key.to_owned(), value);
                    true
                }
            }
            None => map.remove(key).is_some(),
        }
    }

    fn update_inbox(&mut self, data: &Value) -> Result<()> {
        let target = data["target"]
            .as_str()
            .filter(|target| matches!(*target, "next-turn" | "next-step"))
            .context("DSH 队列事件无效")?;
        let start = data["start"]
            .as_u64()
            .and_then(|start| usize::try_from(start).ok())
            .context("DSH 队列游标无效")?;
        let removed = data["removedCount"]
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or(0);
        let inserted = data["inserted"].as_array().context("DSH 队列事件无效")?;
        if !self.projections.is_object() {
            self.projections = json!({});
        }
        if !self.projections["inbox"].is_object() {
            self.projections["inbox"] = json!({"next-turn":[],"next-step":[]});
        }
        let queue = self.projections["inbox"][target]
            .as_array_mut()
            .context("DSH 队列无效")?;
        let end = start
            .checked_add(removed)
            .filter(|end| *end <= queue.len())
            .context("DSH 队列游标无效")?;
        ensure!(
            queue
                .len()
                .saturating_sub(removed)
                .saturating_add(inserted.len())
                <= 1000,
            "DSH 队列过长"
        );
        queue.splice(start..end, inserted.iter().cloned());
        Ok(())
    }

    pub(crate) fn view(&self, id: &str, revision: u64, writable: bool) -> View {
        let streamed = self.attempt.as_ref().and_then(|attempt| {
            let text = attempt.text.values().cloned().collect::<String>();
            (!text.is_empty()).then(|| json!({
                "id":format!("stream-{}", attempt.id),"role":"assistant","text":text,"turnId":attempt.turn.to_string(),
            }))
        });
        let turn = self.durable.turn.clone().or_else(|| {
            self.attempt
                .as_ref()
                .map(|attempt| attempt.turn.to_string())
        });
        let running = turn.is_some();
        let inbox = &self.projections["inbox"];
        let queue: Vec<_> = ["next-turn", "next-step"]
            .iter()
            .flat_map(|target| inbox[*target].as_array().into_iter().flatten())
            .collect();
        let queued: Vec<_> = queue
            .iter()
            .filter_map(|entry| {
                let id = entry["id"].as_str()?;
                let text = super::dsh::blocks(entry, "text");
                let text = &text[..text.floor_char_boundary(text.len().min(12_000))];
                Some(json!({"id":id,"text":text,"status":"queued"}))
            })
            .collect();
        let queue_fingerprint = inbox.is_object().then(|| hash(&json!(queue).to_string()));
        let selection = &self.projections["modelSelection"]["next"];
        View {
            thread: json!({
                "id":id,"title":self.projections["title"].as_str().unwrap_or("新会话"),
                "cwd":self.header["cwd"].as_str().unwrap_or_default(),
                "updatedAt":self.header["createdAt"].as_i64().unwrap_or_default(),
                "owner":writable,"synchronized":true,"runtimeStatus":if running {"running"} else {"idle"},
                "revision":revision,"activeTurnId":turn,"model":dsh_settings::model(selection),
                "reasoningEffort":dsh_settings::effort(selection),"mode":dsh_settings::mode(&self.projections),
                "controls":dsh_settings::state(&self.projections),"pendingRequests":0,"requests":[],
                "canSend":writable && !running,"canSteer":writable && running,"canInterrupt":writable && running,
                "queuedMessages":queued,"queueFingerprint":queue_fingerprint,
                "reason":if writable {Value::Null} else {json!("DSH 原生只读")},"projectId":null,"projectName":null,
            }),
            messages: self.durable.messages.clone(),
            streamed,
            observations: self.durable.observations.clone(),
        }
    }
}

fn observe(records: &[Value]) -> (Option<String>, Vec<Observation>) {
    let mut active = None;
    let mut requests: HashMap<String, Vec<Uuid>> = HashMap::new();
    let mut terminal = Vec::new();
    let mut events: Vec<_> = records.iter().map(|r| &r["event"]).collect();
    events.sort_unstable_by_key(|event| event["seq"].as_i64());
    for event in events {
        let data = &event["data"];
        let turn = data["turn"].as_u64().map(|value| value.to_string());
        match event["type"].as_str() {
            Some("turn/end") => {
                let Some(turn) = turn else { continue };
                let state = match data["reason"]["kind"].as_str() {
                    Some("completed") => "completed",
                    Some("aborted" | "interrupted") => "interrupted",
                    Some(_) => "failed",
                    None => continue,
                };
                for id in requests.remove(&turn).into_iter().flatten() {
                    terminal.push(Observation {
                        request: Some(id),
                        turn: turn.clone(),
                        state,
                    });
                }
                terminal.push(Observation {
                    request: None,
                    turn,
                    state,
                });
                active = None;
            }
            Some("user/message") => {
                if let Some(turn) = turn {
                    active = Some(turn);
                }
                if data["source"]["kind"] == "user"
                    && let Some(turn) = &active
                    && let Some(id) = data["source"]["rpcId"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                {
                    requests.entry(turn.clone()).or_default().push(id);
                }
            }
            _ => {
                if let Some(turn) = turn {
                    active = Some(turn);
                }
            }
        }
    }
    for (turn, ids) in requests {
        for id in ids {
            terminal.push(Observation {
                request: Some(id),
                turn: turn.clone(),
                state: "accepted",
            });
        }
    }
    (active, terminal)
}
