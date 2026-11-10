use crate::{
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
    io::{self, BufRead, Read, Seek, Write as IoWrite},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;

pub(crate) async fn run_dsh() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut server = None;
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
            "adapter/initialize" if server.is_none() => Server::new(params).map(|ready| {
                server = Some(ready);
                json!({"sdk":1,"watchLifecycle":true})
            }),
            _ => {
                if let Some(server) = &mut server {
                    server.dispatch(method, params, &request["id"]).await
                } else {
                    anyhow::bail!("原生插件尚未初始化");
                }
            }
        };
        let mut response =
            json!({"jsonrpc":"2.0","id":request["id"],"generation":params["generation"]});
        match result {
            Ok(result) => response["result"] = result,
            Err(error) => {
                let missing = error.is::<crate::history_media::MissingAttachment>();
                response["error"] = json!({
                    "code":if missing { -32004 } else { -32000 },
                    "message":if missing { "附件不存在" } else { "原生 DSH 请求失败" }
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
                    Media::Download(source) => self.stage(source).await,
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
                self.stage(self.adapter.export_log(field(params, "thread")?).await?)
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

    async fn stage(&self, mut source: Source) -> Result<Value> {
        let directory = self.directory.join("transfers");
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
                Ok(json!({"path":path,"name":source.name,"temporary":true}))
            })();
            if result.is_err() {
                let _ = fs::remove_file(path);
            }
            result
        })
        .await?
    }
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
