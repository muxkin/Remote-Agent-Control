use crate::{
    codex_backend,
    codex_live::{Outcome, Thread},
    codex_service::{Local, Options, thread_id},
    dsh::Dsh,
    files::BLOCK,
    history_media::Source,
    plugins::{Adapter, Delivery, Media, Subscription, Write},
    state::{private_directory, private_file},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::{self, BufRead, Read, Seek, Write as IoWrite},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{task::JoinHandle, time::timeout};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;

trait Instance: Sized {
    const SCOPED_CODEX: bool = false;

    fn initialize(params: &Value) -> Result<Self>;
    async fn request(&mut self, method: &str, params: &Value, id: &Value) -> Result<Value>;
}

pub(crate) async fn run_dsh() -> Result<()> {
    run::<Server>().await
}

pub(crate) async fn run_codex() -> Result<()> {
    run::<CodexServer>().await
}

async fn run<T: Instance>() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut server: Option<T> = None;
    while let Some(request) = read(&mut input)? {
        let method = field(&request, "method")?;
        let params = &request["params"];
        ensure!(
            request["jsonrpc"] == "2.0"
                && request["id"].is_string()
                && params["generation"].is_string(),
            "原生插件宿主请求无效"
        );
        let result = match method {
            "adapter/check" if params["sdk"] == 1 => Ok(json!({"sdk":1})),
            "adapter/initialize" if server.is_none() => T::initialize(params).map(|ready| {
                server = Some(ready);
                json!({"sdk":1,"watchLifecycle":true,"scopedCodex":T::SCOPED_CODEX})
            }),
            _ => match &mut server {
                Some(server) => server.request(method, params, &request["id"]).await,
                None => anyhow::bail!("原生插件尚未初始化"),
            },
        };
        let mut response =
            json!({"jsonrpc":"2.0","id":request["id"],"generation":params["generation"]});
        match result {
            Ok(result) => response["result"] = result,
            Err(error) => {
                let missing = error.is::<crate::history_media::MissingAttachment>();
                response["error"] = json!({
                    "code":if missing { -32004 } else { -32000 },
                    "message":if missing { "附件不存在" } else { "原生插件请求失败" }
                });
            }
        }
        send(&response)?;
    }
    Ok(())
}

struct Server {
    adapter: Arc<Dsh>,
    directory: PathBuf,
    watches: HashMap<String, (Uuid, Arc<Subscription>)>,
}

impl Instance for Server {
    fn initialize(params: &Value) -> Result<Self> {
        Self::new(params)
    }
    async fn request(&mut self, method: &str, params: &Value, id: &Value) -> Result<Value> {
        self.dispatch(method, params, id).await
    }
}

impl Server {
    fn new(params: &Value) -> Result<Self> {
        ensure!(params["sdk"] == 1, "原生插件 SDK 版本不兼容");
        let config = &params["config"];
        let directory = PathBuf::from(field(params, "stateDirectory")?);
        ensure!(directory.is_absolute(), "原生插件状态目录无效");
        private_directory(&directory)?;
        let adapter = Dsh::new(
            field(params, "id")?.to_owned(),
            field(params, "name")?.to_owned(),
            field(config, "url")?,
            config["version"].as_str().unwrap_or("unknown").to_owned(),
            config["token"].as_str().unwrap_or_default().to_owned(),
            params["readOnly"] == true,
        )?;
        Ok(Self {
            adapter: Arc::new(adapter),
            directory,
            watches: HashMap::new(),
        })
    }

    async fn dispatch(&mut self, method: &str, params: &Value, frame: &Value) -> Result<Value> {
        match method {
            "adapter/status" => {
                let (info, status) = tokio::join!(self.adapter.info(), self.adapter.status());
                Ok(json!({"info":info,"status":status}))
            }
            "adapter/read" => Ok(self
                .adapter
                .read(
                    field(params, "method")?,
                    &params["params"],
                    &params["query"],
                )
                .await?
                .unwrap_or_default()),
            "adapter/view" => self.view(params),
            "adapter/unwatch" => {
                let thread = field(params, "thread")?;
                let watch = Uuid::parse_str(field(params, "watchId")?)?;
                if self
                    .watches
                    .get(thread)
                    .is_some_and(|(current, _)| *current == watch)
                {
                    self.watches.remove(thread);
                }
                Ok(json!({}))
            }
            "adapter/write" => self.write(params, frame).await,
            "adapter/media" => {
                let media = self
                    .adapter
                    .media(field(params, "thread")?, field(params, "reference")?)
                    .await?;
                match media {
                    Media::Download(source) => stage(&self.directory, source).await,
                    Media::VerifiedFile {
                        name,
                        size,
                        attachment_id,
                        sha256,
                    } => Ok(
                        json!({"kind":"verified-file","name":name,"size":size,"attachmentId":attachment_id,"sha256":sha256}),
                    ),
                }
            }
            "adapter/export" => {
                stage(
                    &self.directory,
                    self.adapter.export_log(field(params, "thread")?).await?,
                )
                .await
            }
            _ => anyhow::bail!("原生插件方法无效"),
        }
    }

    fn view(&mut self, params: &Value) -> Result<Value> {
        let thread = field(params, "thread")?;
        let watch = Uuid::parse_str(field(params, "watchId")?)?;
        if self
            .watches
            .get(thread)
            .is_none_or(|(current, _)| *current != watch)
        {
            let subscription = self.adapter.clone().subscribe(thread)?;
            self.watches
                .insert(thread.to_owned(), (watch, subscription));
        }
        let (_, subscription) = self.watches.get(thread).expect("created subscription");
        let view = subscription.0.borrow();
        let Some(view) = &*view else {
            return Ok(Value::Null);
        };
        let messages = &view.messages[view.messages.len().saturating_sub(500)..];
        let observations: Vec<_> = view
            .observations
            .iter()
            .map(|row| {
                json!({
                    "requestId":row.request,"turnId":row.turn,"state":row.state,
                })
            })
            .collect();
        Ok(json!({
            "thread":view.thread,"messages":messages,"streamed":view.streamed,
            "observations":observations,"imageLimits":view.image_limits,
            "continuedQuestions":view.continued_questions,
        }))
    }

    async fn write(&self, params: &Value, frame: &Value) -> Result<Value> {
        let thread = field(params, "thread")?;
        let request = Uuid::parse_str(field(params, "requestId")?)?;
        let action: Write = serde_json::from_value(params["action"].clone())?;
        if let Write::Send {
            skills, plugin_ids, ..
        } = &action
        {
            self.adapter.validate_selection(skills, plugin_ids)?;
        }
        let live = self.watches.get(thread).map(|(_, live)| live.clone());
        let created = |id: &str| {
            send(&json!({
                "jsonrpc":"2.0","method":"adapter/threadCreated","generation":params["generation"],
                "params":{"requestId":frame,"threadId":id},
            }))
        };
        Ok(
            match self
                .adapter
                .write(thread, request, action, live, &created)
                .await
            {
                Delivery::Accepted(turn) => json!({"state":"accepted","turnId":turn}),
                Delivery::Completed(thread) => json!({"state":"completed","resultThreadId":thread}),
                Delivery::Command { id, succeeded } => {
                    json!({"state":"command","commandId":id,"succeeded":succeeded})
                }
                Delivery::Rejected(_) => json!({"state":"rejected"}),
                Delivery::Uncertain => json!({"state":"uncertain"}),
            },
        )
    }
}

struct CodexServer {
    id: String,
    local: Option<Arc<Local>>,
    directory: PathBuf,
    watches: HashMap<Uuid, (Uuid, Arc<Thread>)>,
    jobs: HashMap<Uuid, (Instant, JoinHandle<Outcome>)>,
}

impl Instance for CodexServer {
    const SCOPED_CODEX: bool = true;

    fn initialize(params: &Value) -> Result<Self> {
        Self::new(params)
    }
    async fn request(&mut self, method: &str, params: &Value, _id: &Value) -> Result<Value> {
        self.dispatch(method, params).await
    }
}

impl CodexServer {
    fn new(params: &Value) -> Result<Self> {
        ensure!(params["sdk"] == 1, "原生插件 SDK 版本不兼容");
        let directory = PathBuf::from(field(params, "stateDirectory")?);
        ensure!(directory.is_absolute(), "原生插件状态目录无效");
        private_directory(&directory)?;
        let id = field(params, "id")?;
        ensure!(crate::plugins::valid_instance_id(id), "插件实例标识无效");
        let options: Options = serde_json::from_value(params["config"].clone())?;
        let local = match Local::open(
            &options,
            params["readOnly"] == true,
            id != codex_backend::ID,
        ) {
            Ok(local) => Some(Arc::new(local)),
            Err(error) if options.explicit => return Err(error),
            _ => None,
        };
        Ok(Self {
            id: id.to_owned(),
            local,
            directory,
            watches: HashMap::new(),
            jobs: HashMap::new(),
        })
    }

    fn live(&self, params: &Value, thread: Uuid) -> Option<&Arc<Thread>> {
        let watch = params["watchId"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())?;
        let (target, live) = self.watches.get(&watch)?;
        (*target == thread).then_some(live)
    }

    fn subscribe(&mut self, params: &Value, thread: Uuid) -> Result<Option<Arc<Thread>>> {
        let watch = thread_id(&params["watchId"])?;
        if let Some((target, live)) = self.watches.get(&watch) {
            ensure!(*target == thread, "Codex 订阅会话不符");
            return Ok(Some(live.clone()));
        }
        ensure!(self.watches.len() < 192, "Codex 订阅过多");
        let live = self
            .local
            .as_ref()
            .and_then(|local| local.subscribe(thread));
        if let Some(live) = &live {
            self.watches.insert(watch, (thread, live.clone()));
        }
        Ok(live)
    }

    async fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "adapter/status" => {
                let available = self
                    .local
                    .as_ref()
                    .map(|local| local.availability())
                    .unwrap_or_default();
                return Ok(json!({
                    "info":codex_backend::info(available, false).unwrap_or_else(|| json!({})),
                    "status":codex_backend::status(available, false),
                }));
            }
            "codex/refresh" => {
                let available = match &self.local {
                    Some(local) => local.refresh().await,
                    None => Default::default(),
                };
                return Ok(json!({"availability":available}));
            }
            "codex/view" => {
                let thread = thread_id(&params["thread"])?;
                let live = self.subscribe(params, thread)?;
                let view = live.and_then(|live| live.view.borrow().clone());
                if let Some(view) = &view
                    && params["known"] == json!(view.mark())
                {
                    return Ok(json!({"unchanged":true}));
                }
                return Ok(serde_json::to_value(view.as_deref())?);
            }
            "codex/unwatch" => {
                let watch = thread_id(&params["watchId"])?;
                let thread = thread_id(&params["thread"])?;
                if self
                    .watches
                    .get(&watch)
                    .is_some_and(|(id, _)| *id == thread)
                {
                    self.watches.remove(&watch);
                }
                return Ok(json!({}));
            }
            "codex/manage" => {
                let thread = field(params, "thread")?.to_owned();
                let live = if params["watchId"].is_null() {
                    None
                } else {
                    self.subscribe(params, Uuid::parse_str(&thread)?)?
                };
                let local = self.local.clone().context("尚未配置 Codex")?;
                let id = thread_id(&params["request"])?;
                let change = serde_json::from_value(params["change"].clone())?;
                return self.start_job(id, Duration::from_secs(70), async move {
                    local.manage(id, change, thread, live).await
                });
            }
            "codex/execute" => {
                let thread = thread_id(&params["thread"])?;
                let id = thread_id(&params["request"])?;
                let action = serde_json::from_value(params["action"].clone())?;
                let live = self.live(params, thread).cloned();
                return self.start_job(id, Duration::from_secs(35), async move {
                    Local::execute(live.as_deref(), id, action).await
                });
            }
            "codex/result" => {
                let id = thread_id(&params["request"])?;
                let (_, task) = self.jobs.get(&id).context("Codex 操作结果不存在")?;
                if !task.is_finished() {
                    return Ok(Value::Null);
                }
                let (_, task) = self.jobs.remove(&id).expect("finished Codex job");
                return Ok(serde_json::to_value(
                    task.await.unwrap_or(Outcome::Uncertain),
                )?);
            }
            _ => {}
        }
        let Some(local) = &self.local else {
            return Ok(Value::Null);
        };
        match method {
            "codex/read" => {
                let args = &params["params"];
                let live = thread_id(&args["id"])
                    .ok()
                    .and_then(|id| self.live(params, id));
                Ok(local
                    .read(
                        field(params, "method")?,
                        args,
                        &params["query"],
                        live.map(Arc::as_ref),
                    )
                    .await?
                    .unwrap_or_default())
            }
            "codex/selectTools" => {
                let thread = thread_id(&params["thread"])?;
                let live = self.live(params, thread).map(Arc::as_ref);
                let skills: Vec<String> = serde_json::from_value(params["skills"].clone())?;
                let plugins: Vec<String> = serde_json::from_value(params["plugins"].clone())?;
                Ok(json!(
                    local.select_tools(thread, live, &skills, &plugins).await?
                ))
            }
            "codex/media" => {
                let thread = thread_id(&params["thread"])?;
                let source = local
                    .media(
                        self.id.clone(),
                        thread,
                        field(params, "device")?.to_owned(),
                        field(params, "reference")?.to_owned(),
                        self.live(params, thread).map(Arc::as_ref),
                    )
                    .await?;
                stage(&self.directory, source).await
            }
            _ => anyhow::bail!("原生 Codex 插件方法无效"),
        }
    }

    fn start_job(
        &mut self,
        id: Uuid,
        limit: Duration,
        work: impl Future<Output = Outcome> + Send + 'static,
    ) -> Result<Value> {
        self.jobs
            .retain(|_, (started, _)| started.elapsed() < Duration::from_secs(120));
        ensure!(
            self.jobs.len() < 64 && !self.jobs.contains_key(&id),
            "Codex 操作已存在或过多"
        );
        let task =
            tokio::spawn(async move { timeout(limit, work).await.unwrap_or(Outcome::Uncertain) });
        self.jobs.insert(id, (Instant::now(), task));
        Ok(json!({"started":true}))
    }
}

async fn stage(directory: &Path, mut source: Source) -> Result<Value> {
    let directory = directory.join("transfers");
    tokio::task::spawn_blocking(move || {
        let length = source.file.metadata()?.len();
        ensure!(
            (1..=256 * BLOCK as u64).contains(&length),
            "原生插件附件大小无效"
        );
        private_directory(&directory)?;
        for entry in fs::read_dir(&directory)?.filter_map(Result::ok) {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| Uuid::parse_str(name).is_ok())
                && entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .metadata()
                    .and_then(|info| info.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(600))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
        let path = directory.join(Uuid::new_v4().to_string());
        let result = (|| -> Result<Value> {
            let mut output = private_file(&path, true)?;
            source.file.rewind()?;
            ensure!(
                io::copy(&mut source.file.take(length + 1), &mut output)? == length,
                "原生插件附件已变化"
            );
            let integrity = source
                .expected
                .map(|(size, digest)| json!({"size":size,"sha256":digest}));
            Ok(json!({"path":path,"name":source.name,"temporary":true,"integrity":integrity}))
        })();
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    })
    .await?
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("原生插件请求字段无效")
}

fn read(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut header = Vec::new();
    if (&mut *input).take(128).read_until(b'\n', &mut header)? == 0 {
        return Ok(None);
    }
    let size: usize = std::str::from_utf8(&header)?
        .strip_prefix("Content-Length: ")
        .and_then(|value| value.strip_suffix("\r\n"))
        .context("原生插件请求帧无效")?
        .parse()?;
    ensure!((1..=MAX_FRAME).contains(&size), "原生插件请求过大");
    let mut separator = [0; 2];
    input.read_exact(&mut separator)?;
    ensure!(&separator == b"\r\n", "原生插件请求帧无效");
    let mut body = vec![0; size];
    input.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn send(value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!((1..=MAX_FRAME).contains(&bytes.len()), "原生插件响应过大");
    let mut output = io::stdout().lock();
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}
