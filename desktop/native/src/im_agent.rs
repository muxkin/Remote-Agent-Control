use crate::{
    gateway::{ManagedAgent, Snapshot},
    im_calls,
    im_client::{Client, required},
    state::{private_directory, private_file},
    update::UpdateGate,
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    runtime::Handle,
    sync::watch,
    time::{sleep, timeout},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

const MAX_CURSOR: u64 = (1 << 53) - 1;
const MAX_REPLY: u64 = 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Workers {
    tasks: TaskTracker,
    stop: CancellationToken,
}

impl Workers {
    pub(crate) async fn shutdown(self) {
        self.stop.cancel();
        self.tasks.close();
        let _ = timeout(Duration::from_secs(12), self.tasks.wait()).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    state: PathBuf,
    message_handler: Option<PathBuf>,
    call_handler: Option<PathBuf>,
    environment_file: Option<PathBuf>,
    cursor: Option<u64>,
}

impl Profile {
    fn validate(mut self) -> Result<Self> {
        ensure!(
            (1..=80).contains(&self.id.len())
                && self
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                && self.state.is_absolute()
                && (self.message_handler.is_some() || self.call_handler.is_some())
                && [
                    &self.message_handler,
                    &self.call_handler,
                    &self.environment_file
                ]
                .into_iter()
                .flatten()
                .all(|path| path.is_absolute())
                && self.cursor.is_none_or(|cursor| cursor <= MAX_CURSOR),
            "独立 Agent 配置无效"
        );
        drop(private_file(&self.state, false)?);
        self.state = self.state.canonicalize()?;
        Ok(self)
    }
}

pub(crate) fn start(
    directory: &Path,
    runtime: &Handle,
    workers: &Workers,
    gate: UpdateGate,
    status: watch::Sender<Snapshot>,
) {
    let manifest = env::var_os("POCKET_NATIVE_IM_AGENTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.join("im-agents.json"));
    let rows = match private_file(&manifest, false) {
        Ok(file) => serde_json::from_reader::<_, Vec<Value>>(file.take(128 * 1024))
            .ok()
            .filter(|rows| rows.len() <= 16),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            return;
        }
        Err(_) => None,
    };
    let Some(rows) = rows else {
        configuration_error(&status);
        return;
    };
    if rows.is_empty() {
        return;
    }
    let progress = directory.join("im-agent-progress");
    if private_directory(&progress).is_err() {
        configuration_error(&status);
        return;
    }
    let mut ids = HashSet::new();
    let mut accounts = HashSet::new();
    let mut invalid = false;
    for row in rows {
        let profile = serde_json::from_value::<Profile>(row)
            .map_err(Into::into)
            .and_then(Profile::validate);
        let Ok(profile) = profile else {
            invalid = true;
            continue;
        };
        if ids.contains(&profile.id) || accounts.contains(&profile.state) {
            invalid = true;
            continue;
        }
        ids.insert(profile.id.clone());
        accounts.insert(profile.state.clone());
        if let Some(handler) = profile.call_handler.clone() {
            let online = managed(&status, format!("独立 Agent {} · 通话", profile.id));
            let state = profile.state.clone();
            let environment = profile.environment_file.clone();
            let gate = gate.clone();
            let stop = workers.stop.clone();
            workers.tasks.spawn_on(
                async move {
                    im_calls::supervise(
                        &handler,
                        &state,
                        environment.as_deref(),
                        gate,
                        stop,
                        online,
                    )
                    .await;
                },
                runtime,
            );
        }
        if profile.message_handler.is_some() {
            let online = managed(&status, format!("独立 Agent {} · 消息", profile.id));
            let progress = progress.join(format!("{}.json", profile.id));
            let gate = gate.clone();
            let stop = workers.stop.clone();
            workers.tasks.spawn_on(
                async move {
                    tokio::select! {
                        _ = stop.cancelled() => {}
                        _ = supervise(profile, progress, gate, online) => {}
                    }
                },
                runtime,
            );
        }
    }
    if invalid {
        configuration_error(&status);
    }
}

fn configuration_error(status: &watch::Sender<Snapshot>) {
    status.send_modify(|snapshot| {
        snapshot.agents.push(ManagedAgent {
            name: "独立 Agent 配置有误".into(),
            connected: false,
        })
    });
}

fn managed(status: &watch::Sender<Snapshot>, name: String) -> impl Fn(bool) + use<> {
    let mut index = 0;
    status.send_modify(|snapshot| {
        index = snapshot.agents.len();
        snapshot.agents.push(ManagedAgent {
            name,
            connected: false,
        });
    });
    let status = status.clone();
    move |connected| {
        status.send_if_modified(|snapshot| {
            let row = &mut snapshot.agents[index];
            let changed = row.connected != connected;
            row.connected = connected;
            changed
        });
    }
}

async fn supervise(profile: Profile, progress: PathBuf, gate: UpdateGate, online: impl Fn(bool)) {
    loop {
        let _ = listen(&profile, &progress, &gate, &online).await;
        online(false);
        sleep(Duration::from_secs(5)).await;
    }
}

async fn listen(
    profile: &Profile,
    progress: &Path,
    gate: &UpdateGate,
    online: &impl Fn(bool),
) -> Result<()> {
    let handler = Handler::load(
        profile
            .message_handler
            .as_deref()
            .context("缺少原生消息处理程序")?,
        profile.environment_file.as_deref(),
    )?;
    let client = Client::load(&profile.state)?;
    let lock = private_file(&progress.with_extension("lock"), true)?;
    lock.try_lock().context("独立 Agent 消息已在运行")?;
    client.verify().await?;
    let mut cursor = match private_file(progress, false) {
        Ok(file) => {
            let saved: Value = serde_json::from_reader(file.take(16 * 1024))?;
            ensure!(
                saved["user"] == client.id && saved["origin"] == client.origin,
                "消息游标与账号不符"
            );
            number(&saved["cursor"])?
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            let first = match profile.cursor {
                Some(cursor) => cursor,
                None => number(&client.get("/bootstrap").await?["cursor"])?,
            };
            persist(progress, &client, first)?;
            first
        }
        Err(error) => return Err(error),
    };
    loop {
        let batch = client
            .get(&format!("/sync?cursor={cursor}&wait=25000"))
            .await?;
        let events = batch["events"]
            .as_array()
            .context("独立 Agent 消息批次无效")?;
        let next = number(&batch["cursor"])?;
        online(true);
        let mut paused = false;
        for event in events {
            let sequence = number(&event["sequence"])?;
            if sequence <= cursor || event["message"].is_null() {
                continue;
            }
            let message = &event["message"];
            if message["senderId"] == client.id && message["state"] != "cancelled" {
                continue;
            }
            let Some(_active) = gate.admit() else {
                paused = true;
                break;
            };
            let cid = required(message, "conversationId")?;
            let mut input = event.clone();
            input["message"] = client.decode_message(message).await.unwrap_or_else(|_| {
                let mut safe = message.clone();
                safe["text"] = json!("此消息无法解密或验证；请检查账号及联系人安全码");
                safe["attachments"] = json!([]);
                if let Some(fields) = safe.as_object_mut() {
                    for key in ["interaction", "activities", "initialRequest", "sticker"] {
                        fields.remove(key);
                    }
                }
                safe
            });
            let response = handler.run(&input).await?;
            for (index, reply) in response.replies.iter().enumerate() {
                let default = format!("native-agent-{sequence}-{index}");
                let id = reply.client_id.as_deref().unwrap_or(&default);
                client.send_text(cid, id, &reply.text).await?;
            }
            persist(progress, &client, sequence)?;
            cursor = sequence;
        }
        if paused {
            sleep(Duration::from_millis(200)).await;
        } else if next > cursor {
            persist(progress, &client, next)?;
            cursor = next;
        }
    }
}

fn number(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|cursor| *cursor <= MAX_CURSOR)
        .context("独立 Agent 消息游标无效")
}

fn persist(path: &Path, client: &Client, cursor: u64) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = private_file(&temp, true)?;
        file.write_all(&serde_json::to_vec(&json!({
            "user":client.id,"origin":client.origin,"cursor":cursor,
        }))?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(crate) struct Handler {
    executable: PathBuf,
    environment: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    #[serde(default)]
    replies: Vec<Reply>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    text: String,
    client_id: Option<String>,
}

impl Handler {
    pub(crate) fn load(executable: &Path, environment_file: Option<&Path>) -> Result<Self> {
        let executable = executable.canonicalize()?;
        ensure!(
            executable.is_file()
                && !executable
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| matches!(ext, "mjs" | "js" | "cjs")),
            "独立 Agent 处理程序需要原生可执行文件"
        );
        let environment = environment_file
            .map(|path| -> Result<_> {
                Ok(dotenvy::from_read_iter(private_file(path, false)?)
                    .collect::<dotenvy::Result<BTreeMap<_, _>>>()?)
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            executable,
            environment,
        })
    }

    pub(crate) fn command(&self) -> Result<Command> {
        let mut command = Command::new(&self.executable);
        command
            .env_clear()
            .current_dir(self.executable.parent().context("无效的消息处理程序路径")?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "TZ",
        ] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(&self.environment);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        Ok(command)
    }

    async fn run(&self, event: &Value) -> Result<Response> {
        let mut child = self.command()?.spawn()?;
        let mut input = child.stdin.take().context("消息处理程序缺少输入管道")?;
        let mut output = child
            .stdout
            .take()
            .context("消息处理程序缺少输出管道")?
            .take(MAX_REPLY + 1);
        let body = serde_json::to_vec(&json!({"sdk":1,"event":event}))?;
        let result = timeout(Duration::from_secs(120), async {
            let send = async move { input.write_all(&body).await };
            let mut bytes = Vec::new();
            tokio::try_join!(send, output.read_to_end(&mut bytes))?;
            ensure!(bytes.len() as u64 <= MAX_REPLY, "消息处理程序输出超限");
            ensure!(child.wait().await?.success(), "消息处理程序退出失败");
            let response: Response = serde_json::from_slice(&bytes)?;
            ensure!(response.replies.len() <= 16, "消息处理程序回复数量超限");
            for reply in &response.replies {
                ensure!(
                    !reply.text.trim().is_empty()
                        && reply.text.encode_utf16().count() <= 64_000
                        && reply
                            .client_id
                            .as_ref()
                            .is_none_or(|id| (1..=128).contains(&id.encode_utf16().count())),
                    "消息处理程序回复无效"
                );
            }
            Ok(response)
        })
        .await;
        match result {
            Ok(Ok(response)) => Ok(response),
            failure => {
                let _ = child.kill().await;
                failure?
            }
        }
    }
}
