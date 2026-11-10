use crate::{
    history_media::Source,
    plugin_catalog::{Catalog, Package, Switch},
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
    sync::{Mutex, OwnedRwLockReadGuard, RwLock, watch},
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
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    generation: Uuid,
    ready: bool,
}

impl Process {
    async fn stop(&mut self) -> Result<()> {
        self.ready = false;
        drop(self.input.take());
        if let Ok(result) = timeout(Duration::from_secs(1), self.child.wait()).await {
            result?;
        } else {
            timeout(Duration::from_secs(3), self.child.kill()).await??;
        }
        Ok(())
    }

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
            input: Some(input),
            output,
            generation: Uuid::new_v4(),
            ready: false,
        })
    }

    async fn request(&mut self, method: &str, mut params: Value) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        params["generation"] = json!(self.generation);
        let body =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        ensure!((1..=MAX_FRAME).contains(&body.len()), "原生插件请求过大");
        let input = self.input.as_mut().context("原生插件输入管道已关闭")?;
        input
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .await?;
        input.write_all(&body).await?;
        input.flush().await?;
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
    config: Value,
    directory: PathBuf,
    read_only: bool,
    runtime: Mutex<Runtime>,
    writes: Arc<RwLock<()>>,
    switching: AtomicBool,
    quiesced: AtomicBool,
    epochs: watch::Sender<u64>,
    upload: AtomicBool,
    subscriptions: SyncMutex<HashMap<String, Weak<Subscription>>>,
}

struct Runtime {
    package: Option<Package>,
    process: Option<Process>,
}

impl Runtime {
    async fn stop(&mut self) -> Result<()> {
        if let Some(process) = &mut self.process {
            process.stop().await?;
            self.process = None;
        }
        Ok(())
    }
}

struct Switching<'a>(&'a Host);

impl Drop for Switching<'_> {
    fn drop(&mut self) {
        if self.0.quiesced.swap(false, Ordering::AcqRel) {
            self.0.epochs.send_modify(|epoch| *epoch += 1);
        }
        self.0.switching.store(false, Ordering::Release);
    }
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
            config,
            directory,
            read_only,
            runtime: Mutex::new(Runtime {
                package,
                process: None,
            }),
            writes: Arc::new(RwLock::new(())),
            switching: AtomicBool::new(false),
            quiesced: AtomicBool::new(false),
            epochs: watch::channel(0).0,
            upload: AtomicBool::new(false),
            subscriptions: SyncMutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn supervise(self: Arc<Self>, directory: PathBuf) {
        loop {
            let root = directory.clone();
            let id = self.id.clone();
            let request =
                tokio::task::spawn_blocking(move || Catalog::open(&root)?.next(&id)).await;
            if let Ok(Ok(Some(request))) = request {
                let _ = self.replace(&directory, request).await;
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    async fn replace(&self, directory: &std::path::Path, request: Switch) -> Result<()> {
        self.switching.store(true, Ordering::Release);
        self.upload.store(false, Ordering::Relaxed);
        let _switching = Switching(self);
        let Ok(_drained) = timeout(Duration::from_secs(12), self.writes.write()).await else {
            return self.finish_switch(directory, request, "busy").await;
        };
        self.quiesced.store(true, Ordering::Release);
        self.epochs.send_modify(|epoch| *epoch += 1);
        let Ok(mut slot) = timeout(Duration::from_secs(10), self.runtime.lock()).await else {
            return self.finish_switch(directory, request, "busy").await;
        };
        if slot
            .package
            .as_ref()
            .is_none_or(|package| package.manifest.key() != request.expected)
        {
            return self
                .finish_switch(directory, request, "binding_changed")
                .await;
        }
        if slot.stop().await.is_err() {
            return self
                .finish_switch(directory, request, "shutdown_failed")
                .await;
        }
        if self.initialize(&mut slot, &request.target).await.is_err() {
            if slot.stop().await.is_ok()
                && let Some(previous) = slot.package.clone()
            {
                let _ = self.initialize(&mut slot, &previous).await;
            }
            return self
                .finish_switch(directory, request, "startup_failed")
                .await;
        }
        if let Err(error) = self
            .finish_switch(directory, request.clone(), "applied")
            .await
        {
            slot.stop().await?;
            return Err(error);
        }
        slot.package = Some(request.target);
        Ok(())
    }

    async fn finish_switch(
        &self,
        directory: &std::path::Path,
        request: Switch,
        outcome: &'static str,
    ) -> Result<()> {
        let directory = directory.to_owned();
        let id = self.id.clone();
        tokio::task::spawn_blocking(move || {
            Catalog::open(&directory)?.finish(&request, &id, outcome)
        })
        .await?
    }

    async fn initialize(&self, slot: &mut Runtime, package: &Package) -> Result<()> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || private_directory(&directory)).await??;
        let process = timeout(Duration::from_secs(4), Process::start(package.clone())).await??;
        let process = slot.process.insert(process);
        timeout(Duration::from_secs(5), async {
            let result = process
                .request(
                    "adapter/initialize",
                    json!({
                        "sdk":1,"id":self.id,"name":self.name,"config":self.config,
                        "stateDirectory":self.directory,"readOnly":self.read_only,
                        "packageVersion":package.manifest.version
                    }),
                )
                .await?;
            ensure!(result["sdk"] == 1, "原生插件 SDK 版本不兼容");
            let state = process.request("adapter/status", json!({})).await?;
            ensure!(
                state["info"].is_object() && state["status"].is_object(),
                "原生插件状态无效"
            );
            Ok::<(), anyhow::Error>(())
        })
        .await??;
        process.ready = true;
        Ok(())
    }

    async fn call(&self, method: &'static str, args: Value, limit: Duration) -> Result<Value> {
        let reply = timeout(limit, async {
            let allowed = || !self.quiesced.load(Ordering::Acquire);
            ensure!(allowed(), "原生插件正在切换版本");
            let mut slot = self.runtime.lock().await;
            ensure!(allowed(), "原生插件正在切换版本");
            if !slot.process.as_ref().is_some_and(|process| process.ready) {
                self.upload.store(false, Ordering::Relaxed);
                slot.stop().await?;
                let package = slot.package.clone().context("未安装已绑定的原生插件")?;
                self.initialize(&mut slot, &package).await?;
            }
            let process = slot.process.as_mut().expect("initialized native plugin");
            // Cancelling a frame leaves its stream unusable. Keep the child until it is reaped.
            process.ready = false;
            let mut reply = process.request(method, args).await;
            process.ready = reply
                .as_ref()
                .err()
                .is_none_or(|error| error.is::<Refused>());
            if !process.ready {
                self.upload.store(false, Ordering::Relaxed);
                let _ = slot.stop().await;
            }
            if method == "adapter/status"
                && let (Ok(value), Some(package)) = (&mut reply, &slot.package)
                && value["info"].is_object()
            {
                value["info"]["product"] = json!(package.manifest.product);
                value["info"]["version"] = json!(package.manifest.version);
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
        let mut epochs = self.epochs.subscribe();
        loop {
            let epoch = *epochs.borrow_and_update();
            let value = tokio::select! {
                _ = publish.closed() => return,
                value = self.call("adapter/view", json!({"thread":id}), Duration::from_secs(5)) => value,
            };
            match value {
                Ok(_) if *epochs.borrow() != epoch => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                    continue;
                }
                Ok(value) if last.as_ref() == Some(&value) => {}
                Ok(value) => {
                    if let Ok(view) = view(&value, &id, revision + 1, self.read_only, epoch) {
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
                _ = epochs.changed() => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                }
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
    fn admit_write(&self) -> Result<Option<OwnedRwLockReadGuard<()>>> {
        ensure!(
            !self.switching.load(Ordering::Acquire),
            "原生插件正在切换版本"
        );
        let guard = self
            .writes
            .clone()
            .try_read_owned()
            .context("原生插件正在切换版本")?;
        ensure!(
            !self.switching.load(Ordering::Acquire),
            "原生插件正在切换版本"
        );
        Ok(Some(guard))
    }
    fn uploads_enabled(&self) -> bool {
        !self.read_only
            && !self.switching.load(Ordering::Acquire)
            && self.upload.load(Ordering::Relaxed)
    }
    async fn info(&self) -> Value {
        self.describe()
            .await
            .map(|mut state| state["info"].take())
            .unwrap_or_else(|_| {
                json!({
                    "id":self.id,"name":self.name,"product":"native",
                    "connected":false,"profile":"rust-native-plugin","capabilities":{},
                })
            })
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
            live.0.borrow().as_ref().is_some_and(|view| {
                view.thread["synchronized"] == true
                    && view.plugin_epoch == Some(*self.epochs.borrow())
            })
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

fn view(value: &Value, id: &str, revision: u64, read_only: bool, epoch: u64) -> Result<View> {
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
        plugin_epoch: Some(epoch),
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
