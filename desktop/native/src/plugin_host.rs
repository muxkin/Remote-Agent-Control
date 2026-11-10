use crate::{
    history_media::Source,
    plugin_catalog::Package,
    plugins::{Adapter, Delivery, Media, Observation, RecordCreated, Subscription, View, Write},
    state::{private_directory, private_file},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex as SyncMutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, watch},
    time::{sleep, timeout},
};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;
const READS: &[&str] = &[
    "threads.list",
    "thread.read",
    "history.read",
    "content.read",
    "projects.list",
    "creation.projects",
    "models.list",
    "controls.read",
    "references.list",
    "usage.read",
    "skills.list",
    "plugins.list",
];

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    generation: Uuid,
}

impl Process {
    async fn start(package: Package) -> Result<Self> {
        let executable = tokio::task::spawn_blocking(move || package.executable()).await??;
        let mut command = Command::new(&executable);
        command
            .current_dir(executable.parent().context("原生插件目录无效")?)
            .env_clear();
        for key in [
            "PATH",
            "Path",
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "APPDATA",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "TMPDIR",
            "XDG_RUNTIME_DIR",
            "XDG_STATE_HOME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child.stdin.take().context("原生插件没有输入管道")?;
        let output = BufReader::new(child.stdout.take().context("原生插件没有输出管道")?);
        Ok(Self {
            child,
            input,
            output,
            generation: Uuid::new_v4(),
        })
    }

    async fn request(&mut self, method: &str, mut params: Value) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        params["generation"] = json!(self.generation);
        let body =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        ensure!((1..=MAX_FRAME).contains(&body.len()), "原生插件请求过大");
        self.input
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .await?;
        self.input.write_all(&body).await?;
        self.input.flush().await?;
        let mut header = Vec::new();
        (&mut self.output)
            .take(128)
            .read_until(b'\n', &mut header)
            .await?;
        let header = std::str::from_utf8(&header)?
            .strip_suffix("\r\n")
            .context("原生插件响应帧无效")?;
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .context("原生插件响应帧无效")?
            .parse()?;
        ensure!((1..=MAX_FRAME).contains(&length), "原生插件响应过大");
        let mut separator = [0; 2];
        self.output.read_exact(&mut separator).await?;
        ensure!(&separator == b"\r\n", "原生插件响应帧无效");
        let mut body = vec![0; length];
        self.output.read_exact(&mut body).await?;
        let mut response: Value = serde_json::from_slice(&body)?;
        ensure!(
            response["jsonrpc"] == "2.0"
                && response["id"] == id
                && response["generation"] == self.generation.to_string(),
            "原生插件响应标识无效"
        );
        if response.get("error").is_some() {
            return Err(Refused.into());
        }
        Ok(response
            .get_mut("result")
            .context("原生插件响应缺少结果")?
            .take())
    }
}

#[derive(Debug)]
struct Refused;
impl std::fmt::Display for Refused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("原生插件拒绝请求")
    }
}
impl std::error::Error for Refused {}

pub(crate) async fn check(package: &Package) -> Result<()> {
    let result = timeout(Duration::from_secs(10), async {
        let mut process = Process::start(package.clone()).await?;
        let result = process.request("adapter/check", json!({"sdk":1})).await;
        let _ = process.child.kill().await;
        result
    })
    .await??;
    ensure!(result["sdk"] == 1, "原生插件 SDK 版本不兼容");
    Ok(())
}

pub(crate) struct Host {
    id: String,
    name: String,
    package: Option<Package>,
    config: Value,
    directory: PathBuf,
    read_only: bool,
    process: Mutex<Option<Process>>,
    upload: AtomicBool,
    subscriptions: SyncMutex<HashMap<String, Weak<Subscription>>>,
}

impl Host {
    pub(crate) fn new(
        id: String,
        name: String,
        package: Option<Package>,
        config: Value,
        directory: PathBuf,
        read_only: bool,
    ) -> Self {
        Self {
            id,
            name,
            package,
            config,
            directory,
            read_only,
            process: Mutex::new(None),
            upload: AtomicBool::new(false),
            subscriptions: SyncMutex::new(HashMap::new()),
        }
    }

    async fn call(&self, method: &'static str, args: Value, limit: Duration) -> Result<Value> {
        let reply = timeout(limit, async {
            let mut slot = self.process.lock().await;
            let mut process = if let Some(process) = slot.take() {
                process
            } else {
                self.upload.store(false, Ordering::Relaxed);
                let package = self.package.clone().context("未安装已绑定的原生插件")?;
                let directory = self.directory.clone();
                tokio::task::spawn_blocking(move || private_directory(&directory)).await??;
                let mut process = Process::start(package).await?;
                let result = process
                    .request(
                        "adapter/initialize",
                        json!({
                            "sdk":1,"id":self.id,"name":self.name,"config":self.config,
                            "stateDirectory":self.directory,"readOnly":self.read_only
                        }),
                    )
                    .await?;
                ensure!(result["sdk"] == 1, "原生插件 SDK 版本不兼容");
                process
            };
            let reply = process.request(method, args).await;
            if reply
                .as_ref()
                .err()
                .is_none_or(|error| error.is::<Refused>())
            {
                *slot = Some(process);
            } else {
                self.upload.store(false, Ordering::Relaxed);
            }
            reply
        })
        .await;
        if reply.is_err() {
            self.upload.store(false, Ordering::Relaxed);
        }
        reply?
    }

    async fn describe(&self) -> Result<Value> {
        let mut reply = self
            .call("adapter/status", json!({}), Duration::from_secs(4))
            .await?;
        ensure!(
            reply["info"].is_object() && reply["status"].is_object(),
            "原生插件状态无效"
        );
        reply["info"]["id"] = json!(self.id);
        reply["info"]["name"] = json!(self.name);
        reply["info"]["profile"] = json!("rust-native-plugin");
        reply["info"]["connected"] = json!(reply["status"]["connected"] == true);
        if let Some(package) = &self.package {
            reply["info"]["product"] = json!(package.manifest.product);
            reply["info"]["version"] = json!(package.manifest.version);
        }
        if self.read_only {
            reply["status"]["writesEnabled"] = json!(false);
            if let Some(capabilities) = reply["status"]["capabilities"].as_object_mut() {
                capabilities
                    .values_mut()
                    .for_each(|enabled| *enabled = json!(false));
            }
            if let Some(capabilities) = reply["info"]["capabilities"].as_object_mut() {
                for (name, capability) in capabilities {
                    if name != "history" {
                        *capability = json!({"state":"unavailable"});
                    }
                }
            }
        }
        self.upload.store(
            reply["status"]["writesEnabled"] == true
                && matches!(
                    reply["info"]["capabilities"]["attachments"]["state"].as_str(),
                    Some("supported" | "experimental")
                ),
            Ordering::Relaxed,
        );
        Ok(reply)
    }

    async fn source(&self, method: &'static str, args: Value) -> Result<Source> {
        let reply = self.call(method, args, Duration::from_secs(25)).await?;
        let raw = reply["path"].as_str().context("原生插件没有返回附件")?;
        let name = reply["name"]
            .as_str()
            .filter(|name| {
                (1..=200).contains(&name.encode_utf16().count())
                    && !name
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '/' | '\\'))
            })
            .context("原生插件附件名无效")?
            .to_owned();
        let root = self.directory.clone();
        let file = root.join(raw);
        tokio::task::spawn_blocking(move || {
            let root = root.canonicalize()?;
            let file = file.canonicalize()?;
            ensure!(file.starts_with(root), "原生插件附件不在实例状态目录");
            Ok(Source {
                file: private_file(&file, false)?,
                name,
                expected: None,
            })
        })
        .await?
    }

    async fn follow(&self, id: String, publish: watch::Sender<Option<Arc<View>>>) {
        let mut revision = 0;
        let mut last = None;
        loop {
            let value = tokio::select! {
                _ = publish.closed() => return,
                value = self.call("adapter/view", json!({"thread":id}), Duration::from_secs(5)) => value,
            };
            match value {
                Ok(value) if last.as_ref() == Some(&value) => {}
                Ok(value) => {
                    if let Ok(view) = view(&value, &id, revision + 1, self.read_only) {
                        revision += 1;
                        last = Some(value);
                        publish.send_replace(Some(Arc::new(view)));
                    } else {
                        mark_offline(&publish, &mut revision);
                        last = None;
                    }
                }
                Err(_) => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                }
            }
            tokio::select! {
                _ = publish.closed() => return,
                _ = sleep(Duration::from_millis(if last.is_some() { 350 } else { 900 })) => {}
            }
        }
    }
}

#[async_trait]
impl Adapter for Host {
    fn id(&self) -> &str {
        &self.id
    }
    fn uploads_enabled(&self) -> bool {
        !self.read_only && self.upload.load(Ordering::Relaxed)
    }
    async fn info(&self) -> Value {
        self.describe().await.map(|mut state| state["info"].take()).unwrap_or_else(|_| json!({
            "id":self.id,"name":self.name,"product":self.package.as_ref().map(|p| p.manifest.product.as_str()).unwrap_or("native"),
            "connected":false,"profile":"rust-native-plugin","capabilities":{},
        }))
    }
    async fn status(&self) -> Value {
        self.describe().await.map(|mut state| state["status"].take()).unwrap_or_else(|_| json!({
            "connected":false,"writesEnabled":false,"reason":"原生插件未连接","capabilities":{},
        }))
    }
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        if !READS.contains(&method) {
            return Ok(None);
        }
        self.call(
            "adapter/read",
            json!({"method":method,"params":params,"query":query}),
            Duration::from_secs(12),
        )
        .await
        .map(|value| (!value.is_null()).then_some(value))
    }
    async fn media(&self, thread: &str, reference: &str) -> Result<Media> {
        self.source(
            "adapter/media",
            json!({"thread":thread,"reference":reference}),
        )
        .await
        .map(Media::Download)
    }
    async fn export_log(&self, thread: &str) -> Result<Source> {
        self.source("adapter/export", json!({"thread":thread}))
            .await
    }
    fn subscribe(self: Arc<Self>, thread: &str) -> Result<Arc<Subscription>> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("plugin subscriptions poisoned");
        subscriptions.retain(|_, value| value.strong_count() > 0);
        if let Some(watch) = subscriptions.get(thread).and_then(Weak::upgrade) {
            return Ok(watch);
        }
        ensure!(subscriptions.len() < 32, "原生插件订阅过多");
        let (sender, receiver) = watch::channel(None);
        let subscription = Arc::new(Subscription(receiver));
        subscriptions.insert(thread.to_owned(), Arc::downgrade(&subscription));
        drop(subscriptions);
        let thread = thread.to_owned();
        tokio::spawn(async move { self.follow(thread, sender).await });
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
            return Delivery::Rejected("原生插件实例只读");
        }
        let creates = matches!(action, Write::Create { .. });
        if !matches!(
            action,
            Write::Create { .. } | Write::Open | Write::Rename { .. }
        ) && !live.is_some_and(|live| {
            live.0
                .borrow()
                .as_ref()
                .is_some_and(|view| view.thread["synchronized"] == true)
        }) {
            return Delivery::Rejected("原生插件会话尚未同步");
        }
        let reply = self
            .call(
                "adapter/write",
                json!({"thread":thread,"requestId":request,"action":action}),
                action
                    .dispatch_timeout()
                    .saturating_sub(Duration::from_secs(1)),
            )
            .await;
        match reply {
            Ok(value) => {
                let result = value["resultThreadId"].as_str().filter(|id| valid_id(id));
                if creates
                    && let Some(id) = result
                    && created(id).is_err()
                {
                    return Delivery::Uncertain;
                }
                match value["state"].as_str() {
                    Some("completed") if !creates || result.is_some() => {
                        Delivery::Completed(result.filter(|_| creates).map(str::to_owned))
                    }
                    Some("accepted") if !creates => Delivery::Accepted(
                        value["turnId"]
                            .as_str()
                            .filter(|id| valid_id(id))
                            .map(str::to_owned),
                    ),
                    Some("rejected") if result.is_none() => Delivery::Rejected("原生插件拒绝请求"),
                    _ => Delivery::Uncertain,
                }
            }
            Err(_) => Delivery::Uncertain,
        }
    }
}

fn valid_id(id: &str) -> bool {
    (1..=200).contains(&id.encode_utf16().count())
        && !id
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

fn view(value: &Value, id: &str, revision: u64, read_only: bool) -> Result<View> {
    let mut thread = value["thread"].clone();
    ensure!(
        thread["id"] == id && thread["synchronized"].is_boolean(),
        "原生插件会话快照无效"
    );
    thread["revision"] = json!(revision);
    if read_only {
        for key in ["owner", "canSend", "canSteer", "canInterrupt"] {
            thread[key] = json!(false);
        }
        thread["requests"] = json!([]);
        thread["pendingRequests"] = json!(0);
    }
    let messages = value["messages"]
        .as_array()
        .filter(|rows| rows.len() <= 500)
        .context("原生插件历史快照无效")?;
    ensure!(
        messages
            .iter()
            .all(|row| row["id"].as_str().is_some_and(valid_id)),
        "原生插件消息标识无效"
    );
    let observations: Vec<_> = value["observations"]
        .as_array()
        .into_iter()
        .flatten()
        .take(1000)
        .filter_map(|item| {
            let request = item["requestId"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok());
            let turn = item["turnId"]
                .as_str()
                .filter(|id| valid_id(id))?
                .to_owned();
            let state = match item["state"].as_str()? {
                "accepted" => "accepted",
                "completed" => "completed",
                "interrupted" => "interrupted",
                _ => return None,
            };
            Some(Observation {
                request,
                turn,
                state,
            })
        })
        .collect();
    Ok(View {
        thread,
        messages: messages.clone().into(),
        streamed: None,
        observations: observations.into(),
        image_limits: Value::Null,
        continued_questions: Value::Null,
    })
}

fn mark_offline(publish: &watch::Sender<Option<Arc<View>>>, revision: &mut u64) {
    let latest = publish.borrow().clone();
    if let Some(previous) = latest.filter(|view| view.thread["synchronized"] == true) {
        *revision += 1;
        let mut view = (*previous).clone();
        view.thread["revision"] = json!(*revision);
        for key in ["synchronized", "canSend", "canSteer", "canInterrupt"] {
            view.thread[key] = json!(false);
        }
        view.thread["requests"] = json!([]);
        view.thread["pendingRequests"] = json!(0);
        view.thread["reason"] = json!("原生插件正在重新连接");
        view.observations = Arc::from([]);
        publish.send_replace(Some(Arc::new(view)));
    }
}
