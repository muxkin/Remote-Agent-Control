use crate::{
    app_tools::{Catalog, Tool},
    codex::History,
    codex_live::{Action, Desktop, Outcome, Thread},
    conversations,
    files::{Attachment, Download},
    gateway::{Database, Packet, reply, reply_packet},
    history_media,
    plugins::{Adapter, Control, CreationSettings, Delivery, ModelSettings, Subscription, Write},
    queue, requests, settings,
    state::Device,
};
use anyhow::{Context, Result, ensure};
use futures::AsyncWrite;
use libp2p_identity::PeerId;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::mpsc,
    task::JoinSet,
    time::{Instant, interval, timeout},
};
use uuid::Uuid;

const CODEX: &str = "codex-local";

#[derive(Clone)]
pub struct Backends {
    pub history: Option<History>,
    pub desktop: Option<Desktop>,
    pub direct: Option<crate::direct::Direct>,
    pub storage: Option<crate::storage::Storage>,
    pub update_gate: crate::update::UpdateGate,
    pub plugins: crate::plugins::Registry,
}

impl Backends {
    fn catalog(&self) -> Catalog {
        self.desktop
            .as_ref()
            .map(|desktop| desktop.tools.catalog())
            .unwrap_or_default()
    }

    pub fn status(&self, online: bool) -> Value {
        let catalog = self.catalog();
        let connected = online
            || catalog.has(Tool::Open)
            || catalog.can_create()
            || catalog.has(Tool::Rename)
            || catalog.has(Tool::Fork);
        let reason = match (connected, self.history.is_some()) {
            (true, _) => None,
            (_, true) => Some("请先在本机 Codex 打开此会话。仍可查看已有历史。"),
            _ => Some("尚未配置 Codex 历史"),
        };
        json!({
            "connected": connected, "desktopVersion": null, "supportedVersion": connected,
            "writesEnabled": connected, "reason": reason,
            "capabilities": {
                "send": online, "steer": online, "interrupt": online, "modelSettings": online,
                "questions": online, "approvals": online, "permissionRequests": online,
                "openThread": catalog.has(Tool::Open), "elicitationForms": online,
                "newThread": catalog.can_create(), "queue": online,
                "renameThread": catalog.has(Tool::Rename), "forkThread": catalog.has(Tool::Fork),
                "forkFromTurn": self.desktop.as_ref().is_some_and(|desktop| desktop.reply_fork.supported()),
            }
        })
    }

    fn info(&self, online: bool) -> Option<Value> {
        self.history.as_ref()?;
        let status = self.status(online);
        let mut capabilities = serde_json::Map::new();
        capabilities.insert("history".into(), json!({"state": "supported"}));
        for name in [
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
            let available = match name {
                "open" => status["capabilities"]["openThread"] == true,
                "create" => status["capabilities"]["newThread"] == true,
                "skills" | "plugins" => true,
                "send" | "steer" | "interrupt" | "attachments" | "settings" | "respond"
                | "queue" => online,
                _ => false,
            };
            capabilities.insert(
                name.into(),
                json!({"state": if available { "supported" } else { "unavailable" }}),
            );
        }
        Some(json!({
            "id": CODEX, "product": "codex", "name": "Codex",
            "connected": status["connected"], "version": null, "profile": "rust-native",
            "presentation": {"description":"Codex 桌面",
                "creation":{"empty":true,"permission":"native","preset":false,"plan":false,"notice":"沿用 Codex 创建权限"},
                "plan":"settings","fileReferences":false,"exportLog":false,"nativeCommands":false},
            "capabilities": capabilities,
        }))
    }
}

pub struct DeviceSession {
    db: Database,
    peer: PeerId,
    device: Device,
    backends: Backends,
    watches: HashMap<Uuid, Watch>,
    plugin_watches: HashMap<(String, String), PluginWatch>,
    last_status: Value,
    bulk: bool,
    signaling: Option<Uuid>,
    connection: Option<Arc<dyn webrtc::peer_connection::PeerConnection>>,
}

struct Watch {
    live: Option<Arc<Thread>>,
    fallback: Value,
    fallback_epoch: Uuid,
    fallback_after: Instant,
    published: Option<(Uuid, u64, Option<String>)>,
    versions: HashMap<String, [u8; 32]>,
    operations: HashMap<String, Value>,
}

struct PluginWatch {
    live: Arc<Subscription>,
    epoch: Uuid,
    revision: Option<u64>,
    versions: HashMap<String, [u8; 32]>,
    operations: HashMap<String, Value>,
}

impl DeviceSession {
    pub fn new(
        db: Database,
        peer: PeerId,
        device: Device,
        backends: Backends,
        bulk: bool,
        signaling: Option<Uuid>,
    ) -> Self {
        Self {
            db,
            peer,
            device,
            last_status: backends.status(false),
            backends,
            watches: HashMap::new(),
            plugin_watches: HashMap::new(),
            bulk,
            signaling,
            connection: None,
        }
    }

    pub async fn run(
        mut self,
        mut requests: mpsc::Receiver<Packet>,
        io: &mut (impl AsyncWrite + Unpin),
    ) -> Result<()> {
        let mut updates = interval(Duration::from_millis(160));
        let mut storage_jobs = JoinSet::new();
        let mut desktop_probe = interval(Duration::from_secs(10));
        let mut probing = JoinSet::new();
        loop {
            tokio::select! {
                Some(result) = storage_jobs.join_next(), if !storage_jobs.is_empty() => {
                    if let Ok((id, result)) = result {
                        let response = match result {
                            Ok(value) => json!({"type":"response","id":id,"result":value}),
                            Err(_) => json!({"type":"response","id":id,"status":503,"error":"对象存储操作未完成"}),
                        };
                        reply(io, response).await?;
                    }
                }
                _ = desktop_probe.tick(), if !self.bulk && probing.is_empty() && self.backends.desktop.is_some() => {
                    let desktop = self.backends.desktop.as_ref().unwrap().clone();
                    probing.spawn(async move {
                        tokio::join!(desktop.tools.refresh(), desktop.reply_fork.probe());
                    });
                }
                Some(_) = probing.join_next(), if !probing.is_empty() => {
                    self.ensure_device()?;
                    self.publish(io).await?;
                }
                _ = updates.tick(), if !self.bulk && !(self.watches.is_empty() && self.plugin_watches.is_empty()) => {
                    self.ensure_device()?;
                    self.publish(io).await?;
                    self.publish_plugins(io).await?;
                }
                request = requests.recv() => {
                    let Some(Packet { value: request, bytes }) = request else { return Ok(()) };
                    self.ensure_device()?;
                    let Some(id) = request["id"].as_str().and_then(|value| Uuid::parse_str(value).ok()) else { continue };
                    if request["type"] == "file" && codex(&request) && bytes.is_empty()
                        && matches!(request["action"].as_str(), Some("storage-plan" | "storage-import" | "storage-done"))
                    {
                        if let Some(storage) = self.backends.storage.clone().filter(|_| storage_jobs.len() < 2) {
                            let db = self.db.clone();
                            let device = self.device.id.clone();
                            storage_jobs.spawn(async move {
                                let result = async {
                                    storage.handle(db, device, thread_id(&request["threadId"])?,
                                        thread_id(&request["fileId"])?, request["action"].as_str().unwrap(), &request).await
                                }.await;
                                (id, result)
                            });
                        } else {
                            reply(io, json!({"type":"response","id":id,"status":503,"error":"对象存储当前不可用"})).await?;
                        }
                        continue;
                    }
                    let mut reply_bytes = Vec::new();
                    let result = match request["type"].as_str() {
                        Some("rpc") if !self.bulk && bytes.is_empty() => self.rpc(request["call"].clone()).await,
                        Some("file") if codex(&request) => self.file(request.clone(), bytes).await.map(|(value, bytes)| {
                            reply_bytes = bytes;
                            Some(value)
                        }),
                        Some("watch") if !self.bulk && bytes.is_empty() => {
                            if codex(&request) {
                                self.watch(&request).await.map(Some)
                            } else {
                                self.plugin_watch(&request)
                            }
                        },
                        Some("offer") if bytes.is_empty() && self.signaling.is_some() => self.offer(&request).await.map(Some),
                        Some("candidate") if bytes.is_empty() && self.signaling.is_some() => {
                            match &self.connection {
                                Some(connection) => crate::direct::candidate(connection.as_ref(), request["candidate"].clone()).await.map(|()| Some(json!({"ok":true}))),
                                None => Ok(None),
                            }
                        }
                        Some("unwatch") if !self.bulk && bytes.is_empty() => {
                            if codex(&request) {
                                self.watches.remove(&thread_id(&request["threadId"])?);
                            } else if let (Some(backend), Some(thread)) = (request["backendId"].as_str(), request["threadId"].as_str()) {
                                self.plugin_watches.remove(&(backend.to_owned(), thread.to_owned()));
                            }
                            Ok(Some(json!({"ok": true})))
                        }
                        Some("ping") => Ok(Some(json!({"ok": true}))),
                        _ => Ok(None),
                    };
                    let value = match result {
                        Ok(Some(result)) => json!({"type":"response","id":id,"result":result}),
                        Ok(None) => json!({"type":"response","id":id,"status":404,"error":"会话或功能不可用"}),
                        Err(error) if error.is::<Conflict>() => {
                            json!({"type":"response","id":id,"status":409,"error":"请求 ID 已用于其他操作"})
                        }
                        Err(error) if error.is::<history_media::MissingAttachment>() => {
                            json!({"type":"response","id":id,"status":404,"error":error.to_string()})
                        }
                        Err(_) => json!({"type":"response","id":id,"status":400,"error":"请求未完成，请核对本机会话和参数"}),
                    };
                    reply_packet(io, value, &reply_bytes).await?;
                    if !self.bulk && request["call"]["method"] == "device.revoke" {
                        // Let the encrypted response reach the requesting client.
                        tokio::time::sleep(Duration::from_millis(35)).await;
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn offer(&mut self, request: &Value) -> Result<Value> {
        let direct = self.backends.direct.clone().context("直连未启用")?;
        let session = self.signaling.context("此通道不能协商直连")?;
        let sdp = request["sdp"].as_str().context("WebRTC offer 无效")?;
        if let Some(previous) = self.connection.take() {
            let _ = previous.close().await;
        }
        let (connection, answer) = direct
            .answer(
                sdp.to_owned(),
                self.db.clone(),
                self.peer,
                self.device.ticket.clone(),
                session,
                self.backends.clone(),
            )
            .await?;
        self.connection = Some(connection);
        Ok(json!({"sdp":answer}))
    }

    fn ensure_device(&self) -> Result<()> {
        let current = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .device(self.peer)?;
        ensure!(
            current.is_some_and(|value| value.id == self.device.id),
            "设备已撤销"
        );
        Ok(())
    }

    fn online(&self) -> bool {
        self.watches.values().any(|watch| {
            watch
                .live
                .as_ref()
                .is_some_and(|thread| thread.view.borrow().is_some())
        })
    }

    async fn watch(&mut self, request: &Value) -> Result<Value> {
        let id = thread_id(&request["threadId"])?;
        if let Some(watch) = self.watches.get_mut(&id) {
            watch.published = None;
            watch.versions.clear();
            return Ok(json!({"ok": true}));
        }
        ensure!(
            self.watches.len() + self.plugin_watches.len() < 8,
            "订阅数量过多"
        );
        let history = self.backends.history.clone().context("尚未配置 Codex")?;
        let fallback = tokio::task::spawn_blocking(move || {
            let params = json!({"id": id});
            let summary = history
                .rpc("thread.read", &params, &Value::Null)?
                .context("找不到此会话")?;
            let page = history
                .rpc("history.read", &params, &Value::Null)
                .ok()
                .flatten()
                .unwrap_or_default();
            Ok::<_, anyhow::Error>(
                json!({"thread": summary["thread"], "messages": page["messages"]}),
            )
        })
        .await??;
        let live = self
            .backends
            .desktop
            .as_ref()
            .and_then(|desktop| desktop.subscribe(id));
        self.watches.insert(
            id,
            Watch {
                live,
                fallback,
                fallback_epoch: Uuid::new_v4(),
                fallback_after: Instant::now() + Duration::from_secs(1),
                published: None,
                versions: HashMap::new(),
                operations: HashMap::new(),
            },
        );
        Ok(json!({"ok": true}))
    }

    async fn publish(&mut self, io: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        let status = self.backends.status(self.online());
        if status != self.last_status {
            self.last_status = status.clone();
            reply(
                io,
                json!({"type":"event","backendId":CODEX,"event":{
                    "type":"status","status":status,
                }}),
            )
            .await?;
        }
        for (id, watch) in &mut self.watches {
            let live = watch
                .live
                .as_ref()
                .and_then(|thread| thread.view.borrow().clone());
            let changed = if let Some(view) = live {
                let revision = view.thread["revision"].as_u64().unwrap_or_default();
                let mark = (
                    view.epoch,
                    revision,
                    view.thread["queueFingerprint"].as_str().map(str::to_owned),
                );
                if watch.published.as_ref() == Some(&mark) {
                    None
                } else {
                    self.db
                        .lock()
                        .expect("database mutex poisoned")
                        .observe_operations(&id.to_string(), &view)?;
                    let mut thread = view.thread.clone();
                    for field in ["projectId", "projectName"] {
                        thread[field] = watch.fallback["thread"][field].clone();
                    }
                    Some((mark, thread, view.messages.clone()))
                }
            } else if watch.live.is_some()
                && watch.published.is_none()
                && Instant::now() < watch.fallback_after
            {
                None
            } else {
                let mark = (watch.fallback_epoch, 0, None);
                if watch.published.as_ref() == Some(&mark) {
                    None
                } else {
                    let mut summary = watch.fallback["thread"].clone();
                    let reason = if self.last_status["capabilities"]["openThread"] == true {
                        "已加载历史。选择「继续此会话」连接桌面。"
                    } else {
                        "已加载历史。请在电脑上打开此会话后开始控制。"
                    };
                    let properties = json!({
                        "revision":0,"owner":false,"synchronized":false,"runtimeStatus":"notLoaded",
                        "activeTurnId":null,"model":null,"pendingRequests":0,"canSend":false,"canInterrupt":false,
                        "reason":reason,
                    });
                    if let Some(thread) = summary.as_object_mut() {
                        thread.extend(properties.as_object().unwrap().clone());
                    }
                    Some((
                        mark,
                        summary,
                        watch.fallback["messages"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    ))
                }
            };
            if let Some((mark, thread, messages)) = changed {
                let (order, changed) = diff_messages(messages.iter(), &mut watch.versions)?;
                reply(io, json!({"type":"sync","backendId":CODEX,"threadId":id,"updates":[{
                    "kind":"manifest","epoch":mark.0,"thread":thread,"order":order,"changed":changed,
                }]})).await?;
                watch.published = Some(mark);
            }
            let operations = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .recent_operations(&self.device.id, &id.to_string())?;
            let mut current = HashMap::new();
            for operation in operations {
                let request = operation["id"].as_str().unwrap_or_default().to_owned();
                if watch.operations.get(&request) != Some(&operation) {
                    reply(
                        io,
                        json!({"type":"event","backendId":CODEX,"threadId":id,
                        "event":{"type":"operation","operation":operation}}),
                    )
                    .await?;
                }
                current.insert(request, operation);
            }
            watch.operations = current;
        }
        Ok(())
    }

    async fn file(&self, request: Value, bytes: Vec<u8>) -> Result<(Value, Vec<u8>)> {
        let id = thread_id(&request["fileId"])?;
        let thread = thread_id(&request["threadId"])?;
        let db = self.db.clone();
        let device = self.device.id.clone();
        tokio::task::spawn_blocking(move || {
            let action = request["action"].as_str().context("附件操作无效")?;
            let mut store = db.lock().expect("database mutex poisoned");
            if action == "read" {
                ensure!(bytes.is_empty(), "附件读取参数无效");
                let index = request["index"].as_u64().context("附件块不存在")?;
                return Ok((
                    json!({"index":index}),
                    store.read_upload(&device, thread, id, index)?,
                ));
            }
            Ok((
                store.file_request(
                    &device,
                    thread,
                    id,
                    action,
                    request["index"].as_u64(),
                    &bytes,
                )?,
                Vec::new(),
            ))
        })
        .await?
    }

    fn plugin_watch(&mut self, request: &Value) -> Result<Option<Value>> {
        let Some(plugin) = request["backendId"]
            .as_str()
            .and_then(|id| self.backends.plugins.get(id))
        else {
            return Ok(None);
        };
        let thread = plugin_thread(&request["threadId"])?;
        let key = (plugin.id().to_owned(), thread.to_owned());
        if let Some(watch) = self.plugin_watches.get_mut(&key) {
            watch.revision = None;
            watch.versions.clear();
        } else {
            ensure!(
                self.watches.len() + self.plugin_watches.len() < 8,
                "订阅数量过多"
            );
            self.plugin_watches.insert(
                key,
                PluginWatch {
                    live: plugin.subscribe(thread)?,
                    epoch: Uuid::new_v4(),
                    revision: None,
                    versions: HashMap::new(),
                    operations: HashMap::new(),
                },
            );
        }
        Ok(Some(json!({"ok":true})))
    }

    async fn publish_plugins(&mut self, io: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        for ((backend, thread), watch) in &mut self.plugin_watches {
            let view = watch.live.0.borrow().clone();
            if let Some(view) = view {
                let revision = view.thread["revision"].as_u64();
                if revision != watch.revision {
                    if view.thread["synchronized"] == true {
                        self.db
                            .lock()
                            .expect("database mutex poisoned")
                            .observe_plugin(backend, thread, &view.observations)?;
                    }
                    let (order, changed) = diff_messages(
                        view.messages.iter().chain(view.streamed.iter()),
                        &mut watch.versions,
                    )?;
                    reply(io, json!({"type":"sync","backendId":backend,"threadId":thread,"updates":[{
                        "kind":"manifest","epoch":watch.epoch,"thread":view.thread,"order":order,"changed":changed,
                    }]})).await?;
                    watch.revision = revision;
                }
            }
            let operations = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .recent_operations_for(backend, &self.device.id, thread)?;
            let mut current = HashMap::new();
            for operation in operations {
                let id = operation["id"].as_str().unwrap_or_default().to_owned();
                if watch.operations.get(&id) != Some(&operation) {
                    reply(
                        io,
                        json!({"type":"event","backendId":backend,"threadId":thread,
                            "event":{"type":"operation","operation":operation},
                        }),
                    )
                    .await?;
                }
                current.insert(id, operation);
            }
            watch.operations = current;
        }
        Ok(())
    }

    fn plugin_write(&self, plugin: Arc<dyn Adapter>, method: &str, call: &Value) -> Result<Value> {
        let thread = plugin_thread(&call["params"]["id"])?;
        let (request, action) = match method {
            "settings.update" => {
                let mut body = call["body"].clone();
                let fields = body.as_object_mut().context("DSH 模型设置无效")?;
                let request =
                    serde_json::from_value(fields.remove("requestId").unwrap_or_default())?;
                ensure!(
                    fields.contains_key("expectedModel") && fields.contains_key("expectedEffort"),
                    "DSH 模型状态缺失"
                );
                (
                    request,
                    Write::Settings(serde_json::from_value::<ModelSettings>(body)?),
                )
            }
            "control.execute" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct ControlRequest {
                    request_id: Uuid,
                    control: Control,
                }
                let body: ControlRequest = serde_json::from_value(call["body"].clone())?;
                if matches!(&body.control, Control::Permission { .. }) {
                    ensure!(
                        call["body"]["control"].get("expected").is_some(),
                        "DSH 权限状态缺失"
                    );
                }
                (body.request_id, Write::Control(body.control))
            }
            _ => serde_json::from_value::<PluginRequest>(call["body"].clone())?.parse(method)?,
        };
        let live = self
            .plugin_watches
            .get(&(plugin.id().to_owned(), thread.to_owned()))
            .map(|watch| watch.live.clone());
        if matches!(&action, Write::Create { .. }) {
            ensure!(thread == "new" || live.is_some(), "请先打开 DSH 会话");
        } else {
            ensure!(live.is_some(), "请先打开 DSH 会话");
        }
        let (operation, fresh) = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .begin_plugin(plugin.id(), request, &self.device.id, thread, &action)
            .map_err(|_| Conflict)?;
        if fresh {
            let db = self.db.clone();
            let thread = thread.to_owned();
            tokio::spawn(async move {
                let created = |id: &str| {
                    db.lock()
                        .expect("database mutex poisoned")
                        .record_plugin_thread(plugin.id(), request, id)
                };
                let result = timeout(
                    Duration::from_secs(45),
                    plugin.write(&thread, request, action, live.clone(), &created),
                )
                .await
                .unwrap_or(Delivery::Uncertain);
                let view = live.and_then(|live| live.0.borrow().clone());
                let mut db = db.lock().expect("database mutex poisoned");
                if db.finish_plugin(plugin.id(), request, result).is_ok()
                    && let Some(view) = view.filter(|value| value.thread["synchronized"] == true)
                {
                    let _ = db.observe_plugin(plugin.id(), &thread, &view.observations);
                }
            });
        }
        Ok(operation)
    }

    async fn rpc(&mut self, call: Value) -> Result<Option<Value>> {
        let method = call["method"].as_str().unwrap_or_default();
        let online = self.online();
        if method == "backends.list" {
            let mut backends: Vec<_> = self.backends.info(online).into_iter().collect();
            backends.extend(self.backends.plugins.infos().await);
            return Ok(Some(json!({"backends":backends})));
        }
        if method != "device.revoke" && !codex(&call) {
            let Some(plugin) = call["backendId"]
                .as_str()
                .and_then(|id| self.backends.plugins.get(id))
            else {
                return Ok(None);
            };
            return match method {
                "status.read" => Ok(Some(plugin.status().await)),
                "session.read" => Ok(Some(json!({
                    "device":{"id":self.device.id,"name":self.device.name},
                    "status":plugin.status().await,"backend":plugin.info().await,
                }))),
                "operation.read" => {
                    let id = thread_id(&call["params"]["id"])?;
                    self.db
                        .lock()
                        .expect("database mutex poisoned")
                        .operation_for(plugin.id(), &self.device.id, &id.to_string())
                }
                "operations.list" => {
                    let thread = plugin_thread(&call["params"]["id"])?;
                    let operations = self
                        .db
                        .lock()
                        .expect("database mutex poisoned")
                        .recent_operations_for(plugin.id(), &self.device.id, thread)?;
                    Ok(Some(json!(operations)))
                }
                "message.send" | "turn.steer" | "turn.interrupt" | "thread.rename"
                | "thread.create" | "queue.add" | "queue.remove" | "settings.update"
                | "control.execute" => self.plugin_write(plugin, method, &call).map(Some),
                _ => plugin.read(method, &call["params"], &call["query"]).await,
            };
        }
        match method {
            "status.read" => Ok(Some(self.backends.status(online))),
            "session.read" => Ok(Some(json!({
                "device": {"id": self.device.id,"name":self.device.name},
                "status":self.backends.status(online),"backend":self.backends.info(online),
            }))),
            "device.revoke" => {
                self.db
                    .lock()
                    .expect("database mutex poisoned")
                    .revoke_device(&self.device.id)?;
                Ok(Some(json!({"ok":true})))
            }
            "content.read" => {
                let id = thread_id(&call["params"]["id"])?;
                let message_id = call["query"]["messageId"]
                    .as_str()
                    .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 500)
                    .context("消息 ID 无效")?;
                let view = self
                    .watches
                    .get(&id)
                    .and_then(|watch| watch.live.as_ref())
                    .and_then(|thread| thread.view.borrow().clone());
                if let Some(view) = view
                    && let Some(mut message) = view
                        .messages
                        .iter()
                        .find(|message| message["id"] == message_id)
                        .cloned()
                {
                    if let Some(text) = view.expanded.get(message_id) {
                        message["text"] = json!(text);
                        message["truncated"] = json!(false);
                    }
                    if let Some(details) = view.activities.get(message_id) {
                        crate::tool_activity::apply_details(&mut message, details);
                    }
                    return Ok(Some(json!({"message":message})));
                }
                let Some(history) = self.backends.history.clone() else {
                    return Ok(None);
                };
                let message_id = message_id.to_owned();
                tokio::task::spawn_blocking(move || history.content(id, &message_id)).await?
            }
            "media.describe" => {
                let thread = thread_id(&call["params"]["id"])?;
                let path = call["body"]["path"]
                    .as_str()
                    .filter(|path| (1..=4096).contains(&path.encode_utf16().count()))
                    .context("附件地址无效")?
                    .to_owned();
                let history = self.backends.history.clone().context("尚未配置 Codex")?;
                let view = self
                    .watches
                    .get(&thread)
                    .and_then(|watch| watch.live.as_ref())
                    .and_then(|live| live.view.borrow().clone());
                let db = self.db.clone();
                let device = self.device.id.clone();
                let batch = self
                    .backends
                    .storage
                    .as_ref()
                    .map(crate::storage::Storage::batch);
                tokio::task::spawn_blocking(move || {
                    let native = db.lock().expect("database mutex poisoned").describe_upload(
                        &device,
                        thread,
                        std::path::Path::new(&path),
                    );
                    if let Ok(mut manifest) = native {
                        manifest["storage"] = json!(batch.is_some());
                        if let Some(batch) = batch {
                            manifest["storageBatchBlocks"] = json!(batch);
                        }
                        return Ok(Some(manifest));
                    }
                    let source = history_media::description(
                        &history,
                        thread,
                        &device,
                        &path,
                        view.as_deref(),
                    )?;
                    let download = Download::prepare(source, device, thread, batch)?;
                    db.lock()
                        .expect("database mutex poisoned")
                        .register_download(download)
                        .map(Some)
                })
                .await?
            }
            "upload.begin" if self.backends.desktop.is_some() => {
                let thread = thread_id(&call["params"]["id"])?;
                ensure!(self.watches.contains_key(&thread), "请先打开会话");
                let db = self.db.clone();
                let device = self.device.id.clone();
                let batch = self
                    .backends
                    .storage
                    .as_ref()
                    .map(crate::storage::Storage::batch);
                tokio::task::spawn_blocking(move || {
                    db.lock()
                        .expect("database mutex poisoned")
                        .begin_upload(&device, thread, call["body"].clone(), batch)
                        .map(Some)
                })
                .await?
            }
            "operation.read" => {
                let id = thread_id(&call["params"]["id"])?;
                Ok(self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .operation(&self.device.id, &id.to_string())?)
            }
            "operations.list" => {
                let id = if call["params"]["id"] == "new" {
                    "new".to_owned()
                } else {
                    thread_id(&call["params"]["id"])?.to_string()
                };
                let values = self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .recent_operations(&self.device.id, &id)?;
                Ok(Some(json!(values)))
            }
            "message.send" | "turn.steer" | "turn.interrupt" if self.backends.desktop.is_some() => {
                self.execute(method, &call).await.map(Some)
            }
            "skills.list" | "plugins.list" => {
                let thread = thread_id(&call["params"]["id"])?;
                let catalog = self.tools_catalog(thread).await?;
                let skills = method == "skills.list";
                let name = if skills { "skills" } else { "plugins" };
                Ok(Some(json!({name:catalog.list(skills)})))
            }
            "controls.read" => {
                let id = call["params"]["id"].as_str().context("会话 ID 无效")?;
                let live = Uuid::parse_str(id)
                    .ok()
                    .and_then(|id| self.watches.get(&id))
                    .and_then(|watch| watch.live.as_ref())
                    .and_then(|live| live.view.borrow().clone());
                let state = live.as_ref().map_or_else(
                    || settings::permission(&Value::Null),
                    |view| view.thread["controls"].clone(),
                );
                Ok(Some(settings::controls(state, live.is_some())))
            }
            "queue.add" | "queue.remove" => {
                let thread = thread_id(&call["params"]["id"])?;
                let mut change: queue::Change = serde_json::from_value(call["body"].clone())?;
                change.validate(method == "queue.add")?;
                self.dispatch(thread, change.request_id, Action::Queue { change })
                    .map(Some)
            }
            "request.respond" => {
                let thread = thread_id(&call["params"]["id"])?;
                let response: requests::Response = serde_json::from_value(call["body"].clone())?;
                response.validate()?;
                self.dispatch(thread, response.request_id, Action::Respond { response })
                    .map(Some)
            }
            "settings.update" | "control.execute" => {
                let thread = thread_id(&call["params"]["id"])?;
                let mut body = call["body"].clone();
                let request = thread_id(
                    &body
                        .as_object_mut()
                        .context("设置参数无效")?
                        .remove("requestId")
                        .context("设置参数无效")?,
                )?;
                let action = if method == "settings.update" {
                    let history = self.backends.history.clone().context("尚未配置 Codex")?;
                    let models = tokio::task::spawn_blocking(move || history.models()).await??;
                    Action::Settings {
                        input: settings::model_change(&body, &models)?,
                    }
                } else {
                    ensure!(
                        body.as_object().is_some_and(|value| value.len() == 1),
                        "设置参数无效"
                    );
                    Action::Permission {
                        input: settings::permission_change(&body["control"])?,
                    }
                };
                self.dispatch(thread, request, action).map(Some)
            }
            "creation.projects" => {
                let history = self.backends.history.clone().context("尚未配置 Codex")?;
                let desktop = self.backends.desktop.as_ref().context("尚未连接 Codex")?;
                let id = call["params"]["id"]
                    .as_str()
                    .context("会话 ID 无效")?
                    .to_owned();
                let lookup = history.clone();
                let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&id)).await??;
                let projects = conversations::projects(&desktop.tools, history, &anchor).await?;
                Ok(Some(json!({"projects":projects})))
            }
            "thread.open" | "thread.create" | "thread.rename" | "thread.fork" => {
                self.manage(method, &call).map(Some)
            }
            "usage.read" => {
                let value = if let (Some(desktop), Some(history)) =
                    (&self.backends.desktop, self.backends.history.clone())
                {
                    let anchor = match self.watches.keys().next().copied() {
                        Some(id) => Some(id),
                        None => {
                            tokio::task::spawn_blocking(move || history.latest_thread()).await??
                        }
                    };
                    match anchor {
                        Some(id) => desktop.usage.read(id).await,
                        None => crate::usage::unavailable("暂无可用于查询用量的 Codex 会话"),
                    }
                } else {
                    crate::usage::unavailable("本机桌面用量暂不可用")
                };
                Ok(Some(value))
            }
            _ => {
                let Some(history) = self.backends.history.clone() else {
                    return Ok(None);
                };
                tokio::task::spawn_blocking(move || {
                    history.rpc(
                        call["method"].as_str().unwrap_or_default(),
                        &call["params"],
                        &call["query"],
                    )
                })
                .await?
            }
        }
    }

    fn manage(&self, method: &str, call: &Value) -> Result<Value> {
        let desktop = self.backends.desktop.as_ref().context("尚未连接 Codex")?;
        let history = self.backends.history.clone().context("尚未配置 Codex")?;
        let (request, change) =
            serde_json::from_value::<conversations::Request>(call["body"].clone())?
                .parse(method)?;
        let (thread, live) = if method == "thread.create" && call["params"]["id"] == "new" {
            ("new".to_owned(), None)
        } else {
            let id = thread_id(&call["params"]["id"])?;
            (
                id.to_string(),
                self.watches.get(&id).and_then(|watch| watch.live.clone()),
            )
        };
        let (operation, fresh) = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .begin_management(request, &self.device.id, &thread, change.name(), &change)
            .map_err(|_| Conflict)?;
        if fresh {
            let db = self.db.clone();
            let desktop = desktop.clone();
            tokio::spawn(async move {
                let outcome = change
                    .execute(desktop, history, thread, live, request)
                    .await;
                let _ = db
                    .lock()
                    .expect("database mutex poisoned")
                    .finish_operation(request, outcome);
            });
        }
        Ok(operation)
    }

    async fn tools_catalog(&self, id: Uuid) -> Result<crate::tools_catalog::Catalog> {
        let history = self.backends.history.clone().context("尚未配置 Codex")?;
        let disabled = self
            .watches
            .get(&id)
            .and_then(|watch| watch.live.as_ref())
            .and_then(|live| {
                live.view
                    .borrow()
                    .as_ref()
                    .map(|view| view.disabled_plugins.clone())
            })
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || history.tools(id, &disabled)).await?
    }

    async fn execute(&self, method: &str, call: &Value) -> Result<Value> {
        let thread_id = thread_id(&call["params"]["id"])?;
        let (request, mut action, skills, plugins) = action(method, &call["body"], |ids| {
            let store = self.db.lock().expect("database mutex poisoned");
            ids.iter()
                .map(|id| store.attachment(&self.device.id, thread_id, *id))
                .collect()
        })?;
        if let Action::Send { tools, .. } = &mut action
            && (!skills.is_empty() || !plugins.is_empty())
        {
            *tools = self
                .tools_catalog(thread_id)
                .await?
                .select(&skills, &plugins)?;
        }
        self.dispatch(thread_id, request, action)
    }

    fn dispatch(&self, thread_id: Uuid, request: Uuid, action: Action) -> Result<Value> {
        let thread = self
            .watches
            .get(&thread_id)
            .and_then(|watch| watch.live.clone())
            .context("请先打开会话")?;
        let (operation, fresh) = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .begin_operation(request, &self.device.id, thread_id, &action)
            .map_err(|_| Conflict)?;
        if fresh {
            let db = self.db.clone();
            tokio::spawn(async move {
                let outcome =
                    match timeout(Duration::from_secs(35), thread.execute(action, request)).await {
                        Ok(outcome) => outcome,
                        Err(_) => Outcome::Uncertain,
                    };
                let _ = db
                    .lock()
                    .expect("database mutex poisoned")
                    .finish_operation(request, outcome);
            });
        }
        Ok(operation)
    }
}

fn diff_messages<'a>(
    messages: impl IntoIterator<Item = &'a Value>,
    versions: &mut HashMap<String, [u8; 32]>,
) -> Result<(Vec<&'a str>, Vec<&'a Value>)> {
    let mut order = Vec::new();
    let mut changed = Vec::new();
    let mut current = HashMap::new();
    for message in messages {
        let Some(id) = message["id"].as_str() else {
            continue;
        };
        let fingerprint = Sha256::digest(serde_json::to_vec(message)?).into();
        if versions.get(id) != Some(&fingerprint) {
            changed.push(message);
        }
        current.insert(id.to_owned(), fingerprint);
        order.push(id);
    }
    *versions = current;
    Ok((order, changed))
}

fn plugin_thread(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| {
            (1..=200).contains(&id.encode_utf16().count())
                && !id
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        })
        .context("DSH 会话标识无效")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginRequest {
    request_id: Uuid,
    text: Option<String>,
    expected_turn_id: Option<String>,
    title: Option<String>,
    prompt: Option<String>,
    project_id: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    permission: Option<String>,
    agent_preset: Option<String>,
    plan: Option<bool>,
    expected_queue_fingerprint: Option<String>,
    message_id: Option<String>,
    upload_ids: Option<Vec<Uuid>>,
    skill_ids: Option<Vec<String>>,
    plugin_ids: Option<Vec<String>>,
}

impl PluginRequest {
    fn parse(self, method: &str) -> Result<(Uuid, Write)> {
        ensure!(
            self.upload_ids.as_ref().is_none_or(Vec::is_empty)
                && self.skill_ids.as_ref().is_none_or(Vec::is_empty)
                && self.plugin_ids.as_ref().is_none_or(Vec::is_empty),
            "DSH 附件和技能尚未迁移"
        );
        let text = |input: Option<String>, limit: usize| {
            let value = input.unwrap_or_default();
            let trimmed = value.trim();
            ensure!(
                (1..=limit).contains(&trimmed.encode_utf16().count()),
                "DSH 内容无效"
            );
            Ok::<_, anyhow::Error>(trimmed.to_owned())
        };
        let expected = || {
            self.expected_turn_id
                .as_deref()
                .filter(|id| !id.is_empty() && id.len() <= 200)
                .map(str::to_owned)
                .context("当前回合无效")
        };
        let settings = CreationSettings {
            model: self.model,
            thinking: self.thinking,
            permission: self.permission,
            preset: self.agent_preset,
            plan: self.plan,
        };
        if method != "thread.create" {
            ensure!(
                self.prompt.is_none() && self.project_id.is_none() && settings.is_empty(),
                "DSH 请求参数无效"
            );
        }
        let queue = matches!(method, "queue.add" | "queue.remove");
        if !queue {
            ensure!(
                self.expected_queue_fingerprint.is_none() && self.message_id.is_none(),
                "DSH 请求参数无效"
            );
        }
        let queue_fingerprint = || {
            self.expected_queue_fingerprint
                .as_ref()
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .cloned()
                .context("队列指纹无效")
        };
        let action = match method {
            "message.send" if self.title.is_none() && self.expected_turn_id.is_none() => {
                Write::Send {
                    text: text(self.text, 16_000)?,
                }
            }
            "turn.steer" if self.title.is_none() => Write::Steer {
                expected: expected()?,
                text: text(self.text, 16_000)?,
            },
            "turn.interrupt" if self.text.is_none() && self.title.is_none() => Write::Interrupt {
                expected: expected()?,
            },
            "thread.rename" if self.text.is_none() && self.expected_turn_id.is_none() => {
                let title = text(self.title, 160)?;
                ensure!(!title.chars().any(char::is_control), "会话名称无效");
                Write::Rename { title }
            }
            "queue.add"
                if self.title.is_none()
                    && self.expected_turn_id.is_none()
                    && self.message_id.is_none() =>
            {
                Write::Queue {
                    text: text(self.text, 16_000)?,
                    expected: queue_fingerprint()?,
                }
            }
            "queue.remove"
                if self.title.is_none()
                    && self.expected_turn_id.is_none()
                    && self.text.is_none() =>
            {
                let message = self
                    .message_id
                    .filter(|id| {
                        (1..=200).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)
                    })
                    .context("队列条目标识无效")?;
                Write::RemoveQueued {
                    message,
                    expected: queue_fingerprint()?,
                }
            }
            "thread.create" if self.text.is_none() && self.expected_turn_id.is_none() => {
                let title = self
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .map(str::to_owned);
                ensure!(
                    title
                        .as_ref()
                        .is_none_or(|title| title.encode_utf16().count() <= 160
                            && !title.chars().any(char::is_control)),
                    "会话名称无效"
                );
                let project = self.project_id;
                ensure!(
                    project
                        .as_ref()
                        .is_none_or(|id| (1..=200).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)),
                    "工作区标识无效"
                );
                Write::Create {
                    title,
                    prompt: text(self.prompt, 16_000)?,
                    project,
                    settings,
                }
            }
            _ => anyhow::bail!("DSH 请求参数无效"),
        };
        Ok((self.request_id, action))
    }
}

#[derive(Debug)]
struct Conflict;
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("operation conflict")
    }
}
impl std::error::Error for Conflict {}

fn codex(value: &Value) -> bool {
    matches!(value.get("backendId"), None) || value["backendId"] == CODEX
}

fn thread_id(value: &Value) -> Result<Uuid> {
    Ok(Uuid::parse_str(value.as_str().context("会话 ID 无效")?)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandBody {
    request_id: Uuid,
    text: Option<String>,
    expected_turn_id: Option<String>,
    upload_ids: Option<Vec<Uuid>>,
    plugin_ids: Option<Vec<String>>,
    skill_ids: Option<Vec<String>>,
}

fn action(
    method: &str,
    body: &Value,
    resolve: impl FnOnce(&[Uuid]) -> Result<Vec<Attachment>>,
) -> Result<(Uuid, Action, Vec<String>, Vec<String>)> {
    let body: CommandBody = serde_json::from_value(body.clone())?;
    let skills = body.skill_ids.unwrap_or_default();
    let plugins = body.plugin_ids.unwrap_or_default();
    for ids in [&skills, &plugins] {
        ensure!(
            ids.len() <= 16
                && (ids.is_empty() || method == "message.send")
                && ids
                    .iter()
                    .all(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())),
            "技能或插件参数无效"
        );
    }
    let ids = body.upload_ids.unwrap_or_default();
    ensure!(ids.len() <= 10, "附件数量过多");
    let files = resolve(&ids)?;
    let text = body
        .text
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    ensure!(text.encode_utf16().count() <= 16_000, "消息文字无效");
    let expected = || {
        body.expected_turn_id
            .filter(|value| (1..=200).contains(&value.encode_utf16().count()))
            .context("目标任务无效")
    };
    let value = match method {
        "message.send" | "turn.steer" => {
            ensure!(
                !text.is_empty() || !files.is_empty(),
                "请输入消息或选择附件"
            );
            if method == "message.send" {
                Action::Send {
                    text,
                    files,
                    tools: Vec::new(),
                }
            } else {
                Action::Steer {
                    text,
                    expected: expected()?,
                    files,
                }
            }
        }
        _ => {
            ensure!(files.is_empty() && text.is_empty(), "中断请求参数无效");
            Action::Interrupt {
                expected: expected()?,
            }
        }
    };
    Ok((body.request_id, value, skills, plugins))
}
