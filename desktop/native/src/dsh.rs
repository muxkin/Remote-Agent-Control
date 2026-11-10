use crate::plugins::Adapter;
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::{SinkExt, StreamExt};
use reqwest::{StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::timeout};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use url::{Host, Url};
use uuid::Uuid;

const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const READS: [&str; 2] = ["session/list", "session/page"];

#[derive(Clone)]
struct Session {
    cookie: String,
    stream: Url,
    obtained: Instant,
}

pub(crate) struct Dsh {
    id: String,
    name: String,
    base: Url,
    version: String,
    token: String,
    http: reqwest::Client,
    session: Mutex<Option<Session>>,
}

impl Dsh {
    pub(crate) fn new(
        id: String,
        name: String,
        url: &str,
        version: String,
        token: String,
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
        })
    }

    async fn authenticate(&self) -> Result<Session> {
        let mut cached = self.session.lock().await;
        if let Some(session) = cached
            .as_ref()
            .filter(|session| session.obtained.elapsed() < Duration::from_secs(300))
        {
            return Ok(session.clone());
        }
        ensure!(!self.token.is_empty(), "DSH 访问凭据未配置");
        let mut url = self.base.join("connect")?;
        url.query_pairs_mut()
            .append_pair("token", &self.token)
            .append_pair("interactions", "answer");
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
        *cached = Some(session.clone());
        Ok(session)
    }

    async fn call(&self, endpoint: &str, args: Value) -> Result<Value> {
        ensure!(READS.contains(&endpoint), "不支持此 DSH 查询");
        let session = self.authenticate().await?;
        let request = Uuid::new_v4();
        let mut response = self.http.post(self.base.join(&format!("api/{endpoint}"))?)
            .header(header::COOKIE, &session.cookie)
            .header(header::ORIGIN, self.base.origin().ascii_serialization())
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"type":"client-request","rpcId":request,"method":endpoint,"payload":{"args":args}}).to_string())
            .send().await.map_err(|_| anyhow::anyhow!("DSH 查询失败"))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            *self.session.lock().await = None;
        }
        ensure!(response.status().is_success(), "DSH 查询失败");
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("DSH 查询未完成"))?
        {
            ensure!(body.len() + chunk.len() <= MAX_RESPONSE, "DSH 查询响应过大");
            body.extend_from_slice(&chunk);
        }
        let mut result: Value = serde_json::from_slice(&body)?;
        ensure!(
            result["type"] == "server-response"
                && result["rpcId"] == request.to_string()
                && result["result"]["ok"] == true,
            "DSH 拒绝查询"
        );
        Ok(result["result"]["value"].take())
    }

    async fn snapshot(&self, id: &str) -> Result<Value> {
        let session = self.authenticate().await?;
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
        let stream = Uuid::new_v4().to_string();
        let result = timeout(Duration::from_secs(10), async {
            let (mut socket, _) = connect_async_with_config(request, Some(config), true).await
                .map_err(|_| anyhow::anyhow!("无法打开 DSH 事件流"))?;
            socket.send(Message::Text(json!({
                "type":"open", "streamId":stream, "endpoint":"session/follow",
                "payload":{"args":{"request":{"address":{"kind":"session","sessionId":id},"maxMessages":100,"assistantStream":false}}}
            }).to_string().into())).await?;
            socket.send(Message::Text(json!({"type":"end","streamId":stream}).to_string().into())).await?;
            while let Some(packet) = socket.next().await {
                let Message::Text(packet) = packet? else { continue };
                let mut frame: Value = serde_json::from_str(&packet)?;
                if frame["streamId"] != stream { continue; }
                if frame["type"] != "item" { break; }
                let snapshot = frame["value"].take();
                if snapshot["type"] == "snapshot" {
                    ensure!(snapshot["header"]["id"] == id && snapshot["header"]["version"] == 4, "不支持此 DSH 会话格式");
                    return Ok(snapshot);
                }
            }
            bail!("DSH 没有返回会话快照")
        }).await?;
        if result.is_err() {
            *self.session.lock().await = None;
        }
        result
    }

    async fn threads(&self, query: &Value) -> Result<Value> {
        let response = self.call("session/list", json!({"_request":{}})).await?;
        let items = response["items"]
            .as_array()
            .context("DSH 会话目录格式无效")?;
        let search = query["q"].as_str().unwrap_or_default().to_lowercase();
        let offset = query["cursor"]
            .as_str()
            .map(str::parse::<usize>)
            .transpose()?
            .unwrap_or(0);
        let limit = query["limit"]
            .as_str()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(50)
            .clamp(1, 200);
        let mut rows = items.iter().filter_map(|item| {
            let id = item["sessionId"].as_str()?;
            let title = item["projections"]["values"]["title"].as_str().unwrap_or("新会话");
            title.to_lowercase().contains(&search).then(|| json!({
                "id":id,"title":title,"cwd":item["cwd"].as_str().unwrap_or_default(),
                "updatedAt":item["updatedAt"].as_i64().unwrap_or_default(),"projectId":null,"projectName":null,
            }))
        }).collect::<Vec<_>>();
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

#[derive(Deserialize)]
struct Cursor {
    id: String,
    through: i64,
    before: i64,
}

fn records(page: &Value) -> Result<&Vec<Value>> {
    let records = page["records"].as_array().context("DSH 历史记录格式无效")?;
    ensure!(records.len() <= 5000, "DSH 历史记录过大");
    Ok(records)
}

fn render(records: &[Value], full: bool) -> Vec<Value> {
    let mut events: Vec<_> = records
        .iter()
        .filter_map(|record| {
            let event = &record["event"];
            Some((event["seq"].as_i64()?, event))
        })
        .collect();
    events.sort_unstable_by_key(|(seq, _)| *seq);
    let mut messages = BTreeMap::new();
    for (seq, event) in events {
        let message = match event["type"].as_str() {
            Some("user/message") => &event["data"],
            Some("assistant/message" | "tool/result") => &event["data"]["message"],
            _ => continue,
        };
        let Some(role @ ("user" | "assistant" | "tool" | "system")) = message["role"].as_str()
        else {
            continue;
        };
        let op = &event["surfaceOp"];
        if op["op"] == "replace"
            && let (Some(first), Some(last)) = (op["startSeq"].as_i64(), op["endSeq"].as_i64())
        {
            messages.retain(|seq, _| !(first..=last).contains(seq));
        }
        let mut text = message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            continue;
        }
        let truncated = !full && text.len() > 12_000;
        if truncated {
            text.truncate(text.floor_char_boundary(12_000));
        }
        messages.insert(seq, json!({
            "id":message["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("event-{seq}")),
            "role":role,"text":text,"truncated":truncated
        }));
    }
    messages
        .into_iter()
        .rev()
        .take(500)
        .map(|(_, message)| message)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[async_trait]
impl Adapter for Dsh {
    fn id(&self) -> &str {
        &self.id
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
            capabilities.insert(name.into(), json!({"state":if connected && name=="history" {"experimental"} else {"unavailable"}}));
        }
        json!({"id":self.id,"name":self.name,"product":"dsh","version":self.version,"connected":connected,
        "profile":"rust-native-readonly","capabilities":capabilities,"presentation":{
            "description":"DSH Web · 原生只读","creation":{"empty":false,"permission":"native","preset":false,"plan":false},
            "plan":"none","fileReferences":false,"exportLog":false,"nativeCommands":false,
        }})
    }
    async fn status(&self) -> Value {
        let connected = self.authenticate().await.is_ok();
        json!({"connected":connected,"writesEnabled":false,"supportedVersion":connected,
            "reason":if connected {"DSH 原生只读"} else {"DSH Web 未连接，请检查实例地址和访问凭据"},"capabilities":{}})
    }
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        match method {
            "threads.list" => return self.threads(query).await.map(Some),
            "projects.list" => return Ok(Some(json!({"projects":[]}))),
            "thread.read" | "history.read" | "content.read" => {}
            _ => return Ok(None),
        }
        let id = params["id"]
            .as_str()
            .filter(|id| (1..=200).contains(&id.len()))
            .context("DSH 会话标识无效")?;
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
        Ok(Some(json!({"thread":{
            "id":id,"title":snapshot["projections"]["values"]["title"].as_str().unwrap_or("新会话"),
            "cwd":snapshot["header"]["cwd"].as_str().unwrap_or_default(),
            "updatedAt":snapshot["header"]["createdAt"].as_i64().unwrap_or_default(),
            "owner":false,"synchronized":true,"runtimeStatus":"idle","revision":snapshot["cursor"],
            "activeTurnId":null,"model":null,"pendingRequests":0,"requests":[],"canSend":false,"canInterrupt":false,
            "reason":"DSH 原生只读","projectId":null,"projectName":null
        },"messages":messages})))
    }
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
