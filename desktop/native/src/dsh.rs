use crate::{
    dsh_events::Hub,
    dsh_live::Timeline,
    plugins::{Adapter, Delivery, Media, RecordCreated, Subscription, Write},
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::{SinkExt, StreamExt};
use reqwest::{StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex as SyncMutex, Weak},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, watch},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use url::{Host, Url};
use uuid::Uuid;

const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const READS: &[&str] = &[
    "session/list",
    "session/page",
    "session/projections",
    "session/modelCatalog",
    "permissionPresets/catalog",
    "agentPresets/list",
    "commands/list",
    "session/attachment",
    "fileReferences/list",
];

#[derive(Clone)]
pub(crate) struct Session {
    cookie: String,
    stream: Url,
    obtained: Instant,
}

pub(crate) struct Dsh {
    id: String,
    name: String,
    pub(crate) base: Url,
    version: String,
    token: String,
    pub(crate) http: reqwest::Client,
    session: Mutex<Option<Session>>,
    subscriptions: SyncMutex<HashMap<String, Weak<Subscription>>>,
    events: SyncMutex<Weak<Hub>>,
    read_only: bool,
}

impl Dsh {
    pub(crate) fn new(
        id: String,
        name: String,
        url: &str,
        version: String,
        token: String,
        read_only: bool,
    ) -> Result<Self> {
        let mut base = Url::parse(url).map_err(|_| anyhow::anyhow!("DSH 服务地址无效"))?;
        ensure!(
            matches!(base.scheme(), "http" | "https")
                && base.host().is_some()
                && base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "DSH 服务地址无效"
        );
        base.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("DSH 服务地址无效"))?
            .pop_if_empty()
            .push("");
        let mut http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10));
        if match base.host() {
            Some(Host::Domain("localhost")) => true,
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        } {
            http = http.no_proxy();
        }
        let http = http.build()?;
        Ok(Self {
            id,
            name,
            base,
            version,
            token,
            http,
            session: Mutex::new(None),
            subscriptions: SyncMutex::new(HashMap::new()),
            events: SyncMutex::new(Weak::new()),
            read_only,
        })
    }

    pub(crate) async fn authenticate(&self) -> Result<Session> {
        let mut cached = self.session.lock().await;
        if let Some(session) = cached
            .as_ref()
            .filter(|session| session.obtained.elapsed() < Duration::from_secs(300))
        {
            return Ok(session.clone());
        }
        let session = self.connect("none").await?;
        *cached = Some(session.clone());
        Ok(session)
    }

    pub(crate) async fn connect(&self, interactions: &'static str) -> Result<Session> {
        ensure!(!self.token.is_empty(), "DSH 访问凭据未配置");
        let mut url = self.base.join("connect")?;
        url.query_pairs_mut()
            .append_pair("token", &self.token)
            .append_pair("interactions", interactions);
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("无法连接 DSH 服务"))?;
        ensure!(response.status() == StatusCode::FOUND, "DSH 拒绝连接");
        let mut stream = self.base.join(
            response
                .headers()
                .get(header::LOCATION)
                .context("DSH 连接响应无效")?
                .to_str()?,
        )?;
        ensure!(
            stream.origin() == self.base.origin()
                && stream.path() == self.base.join("api/remote.mux")?.path()
                && stream.username().is_empty()
                && stream.password().is_none()
                && stream.fragment().is_none(),
            "DSH 连接地址无效"
        );
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok()?.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        ensure!(!cookie.is_empty(), "DSH 未返回连接凭据");
        stream
            .set_scheme(if stream.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .ok()
            .context("DSH 事件流地址无效")?;
        let session = Session {
            cookie,
            stream,
            obtained: Instant::now(),
        };
        Ok(session)
    }

    async fn forget(&self, failed: &Session) {
        let mut cached = self.session.lock().await;
        if cached
            .as_ref()
            .is_some_and(|current| current.obtained == failed.obtained)
        {
            *cached = None;
        }
    }

    pub(crate) async fn call(&self, endpoint: &str, args: Value) -> Result<Value> {
        ensure!(READS.contains(&endpoint), "不支持此 DSH 查询");
        let session = self.authenticate().await?;
        self.exchange(&session, endpoint, args).await
    }

    pub(crate) async fn exchange(
        &self,
        session: &Session,
        endpoint: &str,
        args: Value,
    ) -> Result<Value> {
        let request = Uuid::new_v4();
        let response = self.authorized(session, self.http.post(self.base.join(&format!("api/{endpoint}"))?))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"type":"client-request","rpcId":request,"method":endpoint,"payload":{"args":args}}).to_string())
            .send().await.map_err(|_| anyhow::anyhow!("DSH 请求未完成"))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.forget(session).await;
        }
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(Refused.into());
        }
        let mut result = bounded_json(response, MAX_RESPONSE).await?;
        ensure!(
            result["type"] == "server-response" && result["rpcId"] == request.to_string(),
            "DSH 响应标识无效"
        );
        match result["result"]["ok"].as_bool() {
            Some(true) => Ok(result["result"]["value"].take()),
            Some(false) => match result["result"]["error"]["code"].as_str() {
                Some("gateway/internal" | "gateway/cancelled") | None => bail!("DSH 结果待确认"),
                Some(_) => Err(Refused.into()),
            },
            None => bail!("DSH 响应无效"),
        }
    }

    pub(crate) fn authorized(
        &self,
        session: &Session,
        request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request
            .header(header::COOKIE, &session.cookie)
            .header(header::ORIGIN, self.base.origin().ascii_serialization())
    }

    pub(crate) async fn open_stream(
        &self,
        session: &Session,
        endpoint: &'static str,
        args: Value,
    ) -> Result<Follow> {
        let mut request = session.stream.as_str().into_client_request()?;
        request
            .headers_mut()
            .insert("Cookie", session.cookie.parse()?);
        request
            .headers_mut()
            .insert("Origin", self.base.origin().ascii_serialization().parse()?);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_RESPONSE))
            .max_frame_size(Some(MAX_RESPONSE));
        let (socket, _) = connect_async_with_config(request, Some(config), true)
            .await
            .map_err(|_| anyhow::anyhow!("无法打开 DSH 事件流"))?;
        let mut follow = Follow {
            socket,
            stream: String::new(),
            control: None,
        };
        follow.stream = follow.open(endpoint, args).await?;
        Ok(follow)
    }

    async fn follow(&self, session: &Session, id: &str, live: bool) -> Result<Follow> {
        self.open_stream(session, "session/follow", json!({"request":{
            "address":{"kind":"session","sessionId":id},"maxMessages":100,"assistantStream":live,
        }})).await
    }

    async fn workspaces(&self) -> Result<Vec<Workspace>> {
        let session = self.authenticate().await?;
        let (mut frame, _) = timeout(Duration::from_secs(5), async {
            self.open_stream(&session, "workspace/follow", json!({}))
                .await?
                .next()
                .await
        })
        .await??;
        ensure!(frame["type"] == "baseline", "DSH 工作区目录格式无效");
        let rows: Vec<Workspace> = serde_json::from_value(frame["value"]["items"].take())?;
        ensure!(rows.len() <= 5000, "DSH 工作区目录过大");
        Ok(rows)
    }

    async fn catalog(&self) -> Result<(Vec<Value>, Vec<Workspace>)> {
        let (response, workspaces) = tokio::join!(
            self.call("session/list", json!({"_request":{}})),
            self.workspaces()
        );
        let mut response = response?;
        let items = response["items"]
            .as_array_mut()
            .context("DSH 会话目录格式无效")?;
        let workspaces = workspaces.unwrap_or_default();
        let mut membership = HashMap::new();
        for workspace in &workspaces {
            for id in &workspace.session_ids {
                membership.entry(id.as_str()).or_insert(workspace);
            }
        }
        let rows = items.iter().filter_map(|item| {
            let id = item["sessionId"].as_str()?;
            let workspace = membership.get(id).copied();
            Some(json!({
                "id":id,"title":item["projections"]["values"]["title"].as_str().unwrap_or("新会话"),
                "cwd":item["cwd"].as_str().or(workspace.and_then(|w| w.path.as_deref())).unwrap_or_default(),
                "updatedAt":item["updatedAt"].as_i64().unwrap_or_default(),
                "projectId":workspace.map(|w| &w.workspace_id),"projectName":workspace.map(|w| &w.title),
            }))
        }).collect();
        Ok((rows, workspaces))
    }

    async fn create(
        &self,
        session: &Session,
        request: Uuid,
        action: Write,
        created: &RecordCreated<'_>,
    ) -> Delivery {
        let Write::Create {
            title,
            prompt,
            project,
            mut settings,
        } = action
        else {
            unreachable!()
        };
        let Ok(selection) = self.creation_selection(&settings).await else {
            return Delivery::Rejected("DSH 新会话设置不可用");
        };
        let mut options = json!({"sessionId":request});
        if let Some(project) = project {
            options["workspaceId"] = json!(project);
        }
        if let Some(preset) = settings.preset.take() {
            options["agentPreset"] = json!(preset);
        }
        let result = self
            .exchange(session, "session/create", json!({"request":options}))
            .await;
        let result = match result {
            Ok(value) => value,
            Err(error) if error.is::<Refused>() => return Delivery::Rejected("DSH 拒绝创建会话"),
            Err(_) => return Delivery::Uncertain,
        };
        let Some(id) = result["sessionId"].as_str().filter(|id| valid_thread(id)) else {
            return Delivery::Uncertain;
        };
        if created(id).is_err() {
            return Delivery::Uncertain;
        }
        if !self.initialize_controls(session, id, settings).await {
            return Delivery::Uncertain;
        }
        if let Some(selection) = selection
            && self.select_model(session, id, selection).await.is_err()
        {
            return Delivery::Uncertain;
        }
        if let Some(title) = title {
            match self
                .exchange(
                    session,
                    "session/rename",
                    json!({"request":{"sessionId":id,"title":title}}),
                )
                .await
            {
                Ok(value) if value["title"] == title && value["seq"].is_i64() => {}
                _ => return Delivery::Uncertain,
            }
        }
        match self.exchange(session, "session/prompt", json!({"request":{
            "sessionId":id,"requestId":request,"mode":"queue","content":[{"type":"text","text":prompt}]
        }})).await {
            Ok(value) if value["accepted"] == true => Delivery::Completed(Some(id.to_owned())),
            _ => Delivery::Uncertain,
        }
    }

    pub(crate) async fn snapshot(&self, id: &str) -> Result<Value> {
        let session = self.authenticate().await?;
        let result = timeout(Duration::from_secs(10), async {
            self.follow(&session, id, false)
                .await?
                .baseline(id)
                .await
                .map(|(snapshot, _)| snapshot)
        })
        .await;
        if !matches!(&result, Ok(Ok(_))) {
            self.forget(&session).await;
        }
        result?
    }

    async fn subscribe_loop(
        self: Arc<Self>,
        id: String,
        update: watch::Sender<Option<Arc<crate::plugins::View>>>,
    ) {
        let mut revision = 0;
        let mut wait = Duration::from_millis(500);
        loop {
            let session = tokio::select! {
                _ = update.closed() => break,
                result = self.authenticate() => result,
            };
            if let Ok(session) = session {
                let result = tokio::select! {
                    _ = update.closed() => break,
                    result = self.publish_follow(&session, &id, &update, &mut revision) => result,
                };
                if result.is_ok() {
                    break;
                }
                self.forget(&session).await;
            }
            let previous = update.borrow().clone();
            if let Some(previous) = previous.filter(|value| value.thread["synchronized"] == true) {
                revision += 1;
                let mut stale = (*previous).clone();
                stale.thread["revision"] = json!(revision);
                stale.thread["synchronized"] = json!(false);
                stale.thread["requests"] = json!([]);
                stale.thread["pendingRequests"] = json!(0);
                for capability in ["canSend", "canSteer", "canInterrupt"] {
                    stale.thread[capability] = json!(false);
                }
                stale.thread["reason"] = json!("DSH 连接已断开，正在重新同步");
                update.send_replace(Some(Arc::new(stale)));
                wait = Duration::from_millis(500);
            }
            tokio::select! {
                _ = update.closed() => break,
                _ = sleep(wait) => {}
            }
            wait = (wait * 2).min(Duration::from_secs(8));
        }
    }

    async fn publish_follow(
        self: &Arc<Self>,
        session: &Session,
        id: &str,
        update: &watch::Sender<Option<Arc<crate::plugins::View>>>,
        revision: &mut u64,
    ) -> Result<()> {
        let (mut follow, mut timeline) = timeout(Duration::from_secs(10), async {
            let mut follow = self.follow(session, id, true).await?;
            let (frame, bytes) = follow.baseline(id).await?;
            follow.control = Some(follow.open("session/control", json!({})).await?);
            Ok::<_, anyhow::Error>((follow, Timeline::snapshot(id, frame, bytes)?))
        })
        .await??;
        let mut events: Option<(Arc<Hub>, watch::Receiver<u64>)> = None;
        loop {
            *revision += 1;
            let mut view = timeline.view(id, *revision, !self.read_only);
            if let Some((hub, _)) = &events {
                hub.decorate(id, &mut view);
            }
            if update.send(Some(Arc::new(view))).is_err() {
                return Ok(());
            }
            if events.is_none() && !self.read_only {
                let hub = self.event_hub();
                let receiver = hub.updates();
                events = Some((hub, receiver));
            }
            loop {
                let (frame, bytes) = tokio::select! {
                    frame = follow.next() => frame?,
                    _ = async {
                        match &mut events {
                            Some((_, updates)) => { let _ = updates.changed().await; }
                            None => std::future::pending().await,
                        }
                    } => break,
                };
                if frame["type"] == "snapshot" {
                    timeline = Timeline::snapshot(id, frame, bytes)?;
                    break;
                }
                if timeline.advance(id, frame, bytes)? {
                    break;
                }
            }
        }
    }

    fn event_hub(self: &Arc<Self>) -> Arc<Hub> {
        let mut current = self.events.lock().expect("DSH events mutex poisoned");
        if let Some(hub) = current.upgrade() {
            return hub;
        }
        let hub = Hub::start(self.clone());
        *current = Arc::downgrade(&hub);
        hub
    }

    pub(crate) fn watched_view(&self, thread: &str) -> Option<Arc<crate::plugins::View>> {
        let subscription = self
            .subscriptions
            .lock()
            .expect("DSH subscription mutex poisoned")
            .get(thread)
            .and_then(Weak::upgrade)?;
        let view = subscription.0.borrow().clone()?;
        (view.thread["synchronized"] == true).then_some(view)
    }

    async fn threads(&self, query: &Value) -> Result<Value> {
        let (mut rows, _) = self.catalog().await?;
        let search = query["q"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let project = query["project"].as_str();
        rows.retain(|row| {
            project.is_none_or(|project| {
                if project == "none" {
                    row["projectId"].is_null()
                } else {
                    row["projectId"] == project
                }
            }) && row["title"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&search)
        });
        let offset = query["cursor"]
            .as_str()
            .map(str::parse::<usize>)
            .transpose()?
            .unwrap_or(0);
        let limit = query["limit"]
            .as_str()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(30)
            .clamp(1, 200);
        rows.sort_by(|a, b| {
            b["updatedAt"]
                .as_i64()
                .cmp(&a["updatedAt"].as_i64())
                .then(a["id"].as_str().cmp(&b["id"].as_str()))
        });
        let next = offset.saturating_add(limit);
        let cursor = (next < rows.len()).then(|| next.to_string());
        Ok(
            json!({"threads":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"nextCursor":cursor}),
        )
    }
}

pub(crate) async fn bounded_json(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    ensure!(response.status().is_success(), "DSH 请求未完成");
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(body.len() + chunk.len() <= limit, "DSH 响应过大");
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

fn valid_thread(id: &str) -> bool {
    (1..=200).contains(&id.encode_utf16().count())
        && !id
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    workspace_id: String,
    title: String,
    path: Option<String>,
    session_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Refused;
impl std::fmt::Display for Refused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("DSH 拒绝请求")
    }
}
impl std::error::Error for Refused {}

pub(crate) struct Follow {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    pub(crate) stream: String,
    control: Option<String>,
}

impl Follow {
    pub(crate) async fn open(&mut self, endpoint: &'static str, args: Value) -> Result<String> {
        let stream = Uuid::new_v4().to_string();
        self.socket
            .send(Message::Text(
                json!({
                    "type":"open","streamId":stream,"endpoint":endpoint,"payload":{"args":args}
                })
                .to_string()
                .into(),
            ))
            .await?;
        self.socket
            .send(Message::Text(
                json!({"type":"end","streamId":stream}).to_string().into(),
            ))
            .await?;
        Ok(stream)
    }

    pub(crate) async fn cancel(&mut self, stream: &str) -> Result<()> {
        self.socket
            .send(Message::Text(
                json!({"type":"cancel","streamId":stream})
                    .to_string()
                    .into(),
            ))
            .await?;
        Ok(())
    }

    pub(crate) async fn ping(&mut self) -> Result<()> {
        self.socket.send(Message::Ping(Default::default())).await?;
        Ok(())
    }

    pub(crate) async fn packet(&mut self) -> Result<Option<(Value, usize)>> {
        let packet = self.socket.next().await.context("DSH 事件流已断开")??;
        match packet {
            Message::Text(packet) => Ok(Some((serde_json::from_str(&packet)?, packet.len()))),
            Message::Close(_) => bail!("DSH 事件流已断开"),
            _ => Ok(None),
        }
    }

    pub(crate) async fn next(&mut self) -> Result<(Value, usize)> {
        let mut waiting_for_pong = false;
        loop {
            let packet = match timeout(Duration::from_secs(20), self.packet()).await {
                Ok(packet) => packet?,
                Err(_) if waiting_for_pong => bail!("DSH 事件流响应超时"),
                Err(_) => {
                    self.ping().await?;
                    waiting_for_pong = true;
                    continue;
                }
            };
            waiting_for_pong = false;
            let Some((mut frame, len)) = packet else {
                continue;
            };
            let control = self
                .control
                .as_deref()
                .is_some_and(|id| frame["streamId"] == id);
            if !control && frame["streamId"] != self.stream {
                continue;
            }
            ensure!(frame["type"] == "item", "DSH 事件流已结束");
            let mut value = frame["value"].take();
            if control && value["type"] == "baseline" {
                value["type"] = json!("control-baseline");
            }
            return Ok((value, len));
        }
    }

    async fn baseline(&mut self, id: &str) -> Result<(Value, usize)> {
        let (snapshot, bytes) = self.next().await?;
        ensure!(
            snapshot["type"] == "snapshot"
                && snapshot["header"]["id"] == id
                && snapshot["header"]["version"] == 4,
            "不支持此 DSH 会话格式"
        );
        Ok((snapshot, bytes))
    }
}

#[derive(Deserialize)]
struct Cursor {
    id: String,
    through: i64,
    before: i64,
}

pub(crate) fn records(page: &Value) -> Result<&Vec<Value>> {
    let records = page["records"].as_array().context("DSH 历史记录格式无效")?;
    ensure!(records.len() <= 5000, "DSH 历史记录过大");
    Ok(records)
}

pub(crate) fn render(records: &[Value], full: bool) -> Vec<Value> {
    let mut events: Vec<_> = records
        .iter()
        .filter_map(|record| {
            let event = &record["event"];
            Some((event["seq"].as_i64()?, event))
        })
        .collect();
    events.sort_unstable_by_key(|(seq, _)| *seq);
    let mut messages = BTreeMap::<i64, Value>::new();
    let mut commands = HashMap::new();
    let mut turn = None;
    let limit = if full { 512 * 1024 } else { 12_000 };
    for (seq, event) in events {
        let data = &event["data"];
        if event["type"] == "turn/end" {
            turn = None;
        } else if let Some(id) = data["turn"].as_u64() {
            turn = Some(id.to_string());
        }
        let op = &event["surfaceOp"];
        if op["op"] == "replace"
            && let (Some(first), Some(last)) = (op["startSeq"].as_i64(), op["endSeq"].as_i64())
        {
            messages.retain(|seq, _| !(first..=last).contains(seq));
        }
        match event["type"].as_str() {
            Some("command/run") => {
                if let Some(id) = data["commandId"].as_str() {
                    commands.insert(id, seq);
                    messages.insert(seq, json!({"id":format!("command-{id}"),"role":"tool",
                        "text":format!("/{}", capped(&data["name"], 200)),"details":capped(&data["args"],limit),"phase":"running"}));
                }
            }
            Some("command/done") => {
                if let Some(id) = data["commandId"].as_str() {
                    let output = capped(&data["text"], limit);
                    let phase = data["kind"].as_str().unwrap_or("error");
                    if let Some(message) = commands.get(id).and_then(|seq| messages.get_mut(seq)) {
                        message["output"] = json!(output);
                        message["phase"] = json!(phase);
                    } else {
                        messages.insert(
                            seq,
                            json!({"id":format!("command-{id}"),"role":"tool","text":"原生命令",
                            "output":output,"phase":phase}),
                        );
                    }
                }
            }
            Some("tool/call") => {
                if let Some(id) = data["callId"].as_str() {
                    messages.insert(seq, json!({"id":format!("tool-{id}"),"role":"tool",
                        "text":capped(&data["name"],200),"details":capped(&data["arguments"],limit),"turnId":turn}));
                }
            }
            Some(kind @ ("user/message" | "assistant/message" | "tool/result")) => {
                let message = if kind == "user/message" {
                    data
                } else {
                    &data["message"]
                };
                let Some(role @ ("user" | "assistant" | "tool" | "system")) =
                    message["role"].as_str()
                else {
                    continue;
                };
                let text = blocks(message, "text");
                let reasoning = blocks(message, "reasoning");
                let attachments = crate::dsh_media::attachments(message);
                let context = (role == "user")
                    .then(|| message["source"]["kind"].as_str())
                    .flatten()
                    .filter(|kind| *kind != "user");
                if text.is_empty() && reasoning.is_empty() && attachments.is_empty() {
                    continue;
                }
                let truncated = !full && (text.len() > limit || reasoning.len() > limit);
                let details = if context.is_some() { &text } else { &reasoning };
                let displayed = context
                    .map(|kind| {
                        format!(
                            "DSH 上下文 · {}",
                            &kind[..kind.floor_char_boundary(200.min(kind.len()))]
                        )
                    })
                    .unwrap_or_else(|| {
                        text[..text.floor_char_boundary(limit.min(text.len()))].to_owned()
                    });
                let mut item = json!({
                    "id":message["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("event-{seq}")),
                    "role":if context.is_some() {"tool"} else {role}, "text":displayed,
                    "details":&details[..details.floor_char_boundary(limit.min(details.len()))],
                    "turnId":turn,"truncated":truncated,
                });
                if let Some(request) = message["source"]["rpcId"].as_str() {
                    item["clientMessageId"] = json!(request);
                }
                if !attachments.is_empty() {
                    item["attachments"] = json!(attachments);
                }
                messages.insert(seq, item);
            }
            _ => {}
        }
    }
    let mut messages: Vec<_> = messages.into_values().rev().take(500).collect();
    messages.reverse();
    messages
}

fn capped(value: &Value, limit: usize) -> &str {
    let text = value.as_str().unwrap_or_default();
    &text[..text.floor_char_boundary(limit.min(text.len()))]
}

pub(crate) fn blocks(message: &Value, kind: &str) -> String {
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == kind)
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[async_trait]
impl Adapter for Dsh {
    fn id(&self) -> &str {
        &self.id
    }
    fn uploads_enabled(&self) -> bool {
        !self.read_only
    }
    async fn info(&self) -> Value {
        let connected = self.authenticate().await.is_ok();
        let mut capabilities = serde_json::Map::new();
        for name in [
            "history",
            "send",
            "steer",
            "interrupt",
            "respond",
            "settings",
            "queue",
            "create",
            "open",
            "attachments",
            "skills",
            "plugins",
        ] {
            capabilities.insert(name.into(), json!({"state":if connected && (name=="history" || (!self.read_only && matches!(name,"send"|"steer"|"interrupt"|"create"|"queue"|"settings"|"attachments"|"respond"))) {"experimental"} else {"unavailable"}}));
        }
        json!({"id":self.id,"name":self.name,"product":"dsh","version":self.version,"connected":connected,
        "profile":"rust-native","capabilities":capabilities,"presentation":{
            "description":"DSH Web","creation":{"empty":false,"permission":if self.read_only {"native"} else {"select"},"preset":!self.read_only,"plan":!self.read_only},
            "plan":if self.read_only {"none"} else {"control"},"fileReferences":true,"exportLog":false,"nativeCommands":!self.read_only,
        }})
    }
    async fn media(&self, thread: &str, reference: &str) -> Result<Media> {
        self.attachment(thread, reference).await
    }
    async fn status(&self) -> Value {
        let connected = self.authenticate().await.is_ok();
        let writable = connected && !self.read_only;
        let reason = if !connected {
            Some("DSH Web 未连接，请检查实例地址和访问凭据")
        } else if self.read_only {
            Some("DSH 原生只读")
        } else {
            None
        };
        json!({"connected":connected,"writesEnabled":writable,"supportedVersion":self.version == "0.2.1-rc.5",
            "reason":reason,"capabilities":{"send":writable,"steer":writable,"interrupt":writable,"newThread":writable,"queue":writable,"modelSettings":writable,"approvals":writable,"questions":writable}})
    }
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        match method {
            "threads.list" => return self.threads(query).await.map(Some),
            "models.list" => return self.models().await.map(Some),
            "controls.read" => {
                let id = params["id"]
                    .as_str()
                    .filter(|id| valid_thread(id))
                    .context("DSH 会话标识无效")?;
                return self.controls(id, self.read_only).await.map(Some);
            }
            "projects.list" => {
                let (rows, workspaces) = self.catalog().await?;
                let mut counts = HashMap::new();
                for row in &rows {
                    *counts.entry(row["projectId"].as_str()).or_insert(0usize) += 1;
                }
                let projects: Vec<_> = workspaces.iter().map(|w| json!({
                    "id":w.workspace_id,"name":w.title,"count":counts.get(&Some(w.workspace_id.as_str())).copied().unwrap_or_default(),
                })).collect();
                return Ok(Some(
                    json!({"projects":projects,"total":rows.len(),"ungrouped":counts.get(&None).copied().unwrap_or_default()}),
                ));
            }
            "creation.projects" => {
                let projects: Vec<_> = self
                    .workspaces()
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|w| json!({"id":w.workspace_id,"name":w.title}))
                    .collect();
                return Ok(Some(json!({"projects":projects})));
            }
            "thread.read" | "history.read" | "content.read" | "references.list" => {}
            _ => return Ok(None),
        }
        let id = params["id"]
            .as_str()
            .filter(|id| valid_thread(id))
            .context("DSH 会话标识无效")?;
        if method == "references.list" {
            return self
                .file_references(id, query["q"].as_str().unwrap_or_default())
                .await
                .map(Some);
        }
        if method == "history.read"
            && let Some(cursor) = query["cursor"].as_str()
        {
            ensure!(cursor.len() <= 2048, "DSH 历史游标无效");
            let cursor: Cursor = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor)?)?;
            ensure!(
                cursor.id == id && cursor.before >= 0 && cursor.before <= cursor.through,
                "DSH 历史游标无效"
            );
            let page = self.call("session/page", json!({
                "request":{"address":{"kind":"session","sessionId":id},"throughSeq":cursor.through,
                "beforeSeq":cursor.before,"maxMessages":100}
            })).await?;
            return page_reply(id, cursor.through, &page).map(Some);
        }
        let snapshot = self.snapshot(id).await?;
        if method == "history.read" {
            return page_reply(
                id,
                snapshot["cursor"].as_i64().context("DSH 历史游标无效")?,
                &snapshot,
            )
            .map(Some);
        }
        let messages = render(records(&snapshot)?, method == "content.read");
        if method == "content.read" {
            return Ok(messages
                .into_iter()
                .find(|message| message["id"] == query["messageId"])
                .map(|message| json!({"message":message})));
        }
        let size = serde_json::to_vec(&snapshot)?.len();
        let view = Timeline::snapshot(id, snapshot, size)?.view(id, 0, false);
        Ok(Some(json!({"thread":view.thread,"messages":messages})))
    }

    fn subscribe(self: Arc<Self>, id: &str) -> Result<Arc<Subscription>> {
        ensure!(valid_thread(id), "DSH 会话标识无效");
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("DSH subscription lock poisoned");
        subscriptions.retain(|_, value| value.strong_count() > 0);
        if let Some(subscription) = subscriptions.get(id).and_then(Weak::upgrade) {
            return Ok(subscription);
        }
        ensure!(subscriptions.len() < 32, "DSH 订阅数量过多");
        let (send, receive) = watch::channel(None);
        let subscription = Arc::new(Subscription(receive));
        subscriptions.insert(id.to_owned(), Arc::downgrade(&subscription));
        drop(subscriptions);
        let thread = id.to_owned();
        tokio::spawn(async move { self.subscribe_loop(thread, send).await });
        Ok(subscription)
    }

    async fn write(
        &self,
        thread: &str,
        request: Uuid,
        action: Write,
        live: Option<Arc<Subscription>>,
        created: &RecordCreated<'_>,
    ) -> Delivery {
        if self.read_only {
            return Delivery::Rejected("DSH 原生只读");
        }
        let Ok(session) = self.authenticate().await else {
            return Delivery::Rejected("DSH Web 未连接");
        };
        let view = live
            .as_ref()
            .and_then(|live| live.0.borrow().clone())
            .filter(|view| view.thread["synchronized"] == true);
        if matches!(&action, Write::Create { .. }) {
            if thread != "new" && view.is_none() {
                return Delivery::Rejected("DSH 会话尚未同步");
            }
            return self.create(&session, request, action, created).await;
        }
        let (Some(view), Some(live)) = (view, live) else {
            return Delivery::Rejected("DSH 会话尚未同步");
        };
        let active = view.thread["activeTurnId"].as_str();
        let (endpoint, args, accepted) = match action {
            Write::Settings(settings) => {
                return self.change_model(&session, thread, settings).await;
            }
            Write::Control(control) => return self.change_control(&session, thread, control).await,
            Write::Respond(response) => {
                let hub = self
                    .events
                    .lock()
                    .expect("DSH events mutex poisoned")
                    .upgrade();
                let Some(hub) = hub else {
                    return Delivery::Rejected("DSH 交互连接不可用");
                };
                return hub.respond(self, thread, &view, response).await;
            }
            Write::Send { text, files } if active.is_none() => {
                let Ok(content) = self
                    .prompt_content(&session, thread, &text, files, &view.image_limits)
                    .await
                else {
                    return Delivery::Rejected("DSH 未接收附件，消息未发送");
                };
                if !still_on_turn(&live, None) {
                    return Delivery::Rejected("当前回合已变化，请刷新");
                }
                (
                    "session/prompt",
                    json!({"sessionId":thread,"requestId":request,"mode":"queue","content":content}),
                    Delivery::Accepted(None),
                )
            }
            Write::Steer {
                expected,
                text,
                files,
            } if active == Some(expected.as_str()) => {
                let Ok(content) = self
                    .prompt_content(&session, thread, &text, files, &view.image_limits)
                    .await
                else {
                    return Delivery::Rejected("DSH 未接收附件，消息未发送");
                };
                if !still_on_turn(&live, Some(expected.as_str())) {
                    return Delivery::Rejected("当前回合已变化，请刷新");
                }
                (
                    "session/prompt",
                    json!({"sessionId":thread,"requestId":request,"mode":"steer","content":content}),
                    Delivery::Accepted(Some(expected)),
                )
            }
            Write::Interrupt { expected } if active == Some(expected.as_str()) => (
                "session/cancel",
                json!({"sessionId":thread}),
                Delivery::Accepted(Some(expected)),
            ),
            Write::Queue { expected, text } if view.thread["queueFingerprint"] == expected => (
                "session/prompt",
                json!({"sessionId":thread,"requestId":request,"mode":"queue","content":[{"type":"text","text":text}]}),
                Delivery::Accepted(None),
            ),
            Write::RemoveQueued { expected, message }
                if view.thread["queueFingerprint"] == expected
                    && view.thread["queuedMessages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|entry| entry["id"] == message) =>
            {
                (
                    "session/updateQueue",
                    json!({"sessionId":thread,"itemId":message,"action":{"kind":"remove"}}),
                    Delivery::Completed(None),
                )
            }
            Write::Rename { title } => (
                "session/rename",
                json!({"sessionId":thread,"title":title}),
                Delivery::Completed(None),
            ),
            Write::Queue { .. } | Write::RemoveQueued { .. } => {
                return Delivery::Rejected("队列已变化，请刷新");
            }
            _ => return Delivery::Rejected("当前回合已变化，请刷新"),
        };
        match self
            .exchange(&session, endpoint, json!({"request":args}))
            .await
        {
            Ok(value)
                if endpoint == "session/rename"
                    && value["title"] == args["title"]
                    && value["seq"].is_i64() =>
            {
                accepted
            }
            Ok(value) if endpoint != "session/rename" && value["accepted"] == true => accepted,
            Err(error) if error.is::<Refused>() => Delivery::Rejected("DSH 拒绝请求"),
            _ => Delivery::Uncertain,
        }
    }
}

fn still_on_turn(live: &Subscription, expected: Option<&str>) -> bool {
    live.0.borrow().as_ref().is_some_and(|view| {
        view.thread["synchronized"] == true && view.thread["activeTurnId"].as_str() == expected
    })
}

fn page_reply(id: &str, through: i64, snapshot: &Value) -> Result<Value> {
    let rows = records(snapshot)?;
    let before = rows
        .iter()
        .filter_map(|row| row["event"]["seq"].as_i64())
        .min();
    let next = before
        .filter(|_| snapshot["hasMore"] == true)
        .map(|before| {
            URL_SAFE_NO_PAD.encode(json!({"id":id,"through":through,"before":before}).to_string())
        });
    Ok(json!({"messages":render(rows, false),"nextCursor":next}))
}
