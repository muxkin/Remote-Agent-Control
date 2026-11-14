use crate::{codex::History, codex_service::voice_sdp, reply_fork::cli_for_desktop};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Semaphore, mpsc, watch},
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const LEASE: Duration = Duration::from_secs(60);
const MAX_MESSAGE: usize = 512 * 1024;
const MAX_TRANSCRIPT: usize = 16 * 1024;

#[derive(Clone)]
pub struct Voice {
    program: PathBuf,
    history: History,
    slot: Arc<Semaphore>,
}

pub struct Session {
    pub thread: Uuid,
    pub id: Uuid,
    lease: watch::Sender<Instant>,
    cancel: CancellationToken,
    events: mpsc::Receiver<Value>,
}

#[derive(Debug)]
pub struct Failure(pub &'static str);

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Failure {}

impl Session {
    pub fn finished(&self) -> bool {
        self.events.is_closed()
    }

    pub fn poll(&mut self) -> Value {
        self.lease.send_replace(Instant::now() + LEASE);
        let mut events = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            events.push(event);
        }
        json!({"events":events,"done":self.events.is_closed()})
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Voice {
    pub fn new(
        desktop: Option<&Path>,
        cli: Option<&Path>,
        history: History,
        named: bool,
    ) -> Option<Self> {
        let program = match cli {
            Some(path) => path.to_owned(),
            None => bundled_cli(desktop, named)?,
        };
        (program.is_absolute() && program.is_file()).then(|| Self {
            program,
            history,
            slot: Arc::new(Semaphore::new(1)),
        })
    }

    pub fn start(&self, thread: Uuid, id: Uuid, offer: &str) -> Result<Session> {
        ensure!(voice_sdp(offer), Failure("手机未提供有效的语音连接信息"));
        let slot = self
            .slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| Failure("另一台配对设备正在使用 Codex 语音，请稍后重试"))?;
        let voice = self.clone();
        let offer = offer.to_owned();
        let cancel = CancellationToken::new();
        let canceled = cancel.clone();
        let (lease, expiry) = watch::channel(Instant::now() + LEASE);
        let (sender, events) = mpsc::channel(32);
        tokio::spawn(async move {
            let _slot = slot;
            let result = tokio::select! {
                value = voice.run(thread, id, offer, &sender, &canceled) => value,
                _ = expired(expiry) => {
                    // Dropping the isolated process also closes its realtime sideband.
                    Err(Failure("Codex 语音连接已过期").into())
                }
            };
            if !canceled.is_cancelled()
                && let Err(error) = result
            {
                let message = error.downcast_ref::<Failure>().map_or(
                    "本机 Codex 语音连接失败，请检查 Codex 版本、登录状态及语音可用性",
                    |failure| failure.0,
                );
                let _ = sender.try_send(json!({"type":"error","message":message}));
            }
        });
        Ok(Session {
            thread,
            id,
            lease,
            cancel,
            events,
        })
    }

    async fn run(
        &self,
        thread: Uuid,
        session: Uuid,
        offer: String,
        events: &mpsc::Sender<Value>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let history = self.history.clone();
        let (cwd, _) = tokio::task::spawn_blocking(move || history.media_context(thread))
            .await?
            .context(Failure("找不到可用于创建语音分支的已保存会话"))?;
        let mut connection = Connection::spawn(&self.program, self.history.home())?;
        let mut call = AppServer::new(&mut connection);
        // Before the start request there is no call to stop.
        let prepared = tokio::select! {
            value = timeout(STARTUP_TIMEOUT, call.prepare(thread, &cwd)) => value??,
            _ = cancel.cancelled() => return Ok(()),
        };
        let mut notifications = Notifications::new(prepared, events);
        let mut accepted = false;
        let result = tokio::select! {
            result = timeout(STARTUP_TIMEOUT, call.begin(session, &offer, &mut notifications, &mut accepted)) => Some(result),
            _ = cancel.cancelled() => None,
        };
        let result = match result {
            Some(Ok(Ok(()))) => tokio::select! {
                value = call.listen(&mut notifications) => value,
                _ = cancel.cancelled() => Ok(()),
            },
            Some(Ok(Err(error))) => Err(error),
            Some(Err(_)) => {
                Err(Failure("Codex 语音连接超时，请检查电脑能否访问 Codex 后重试").into())
            }
            None => Ok(()),
        };
        if accepted && !notifications.closed {
            let _ = timeout(
                STOP_TIMEOUT,
                call.request("thread/realtime/stop", json!({"threadId":prepared})),
            )
            .await;
        }
        result
    }
}

fn bundled_cli(desktop: Option<&Path>, named: bool) -> Option<PathBuf> {
    if let Some(desktop) = desktop {
        return cli_for_desktop(desktop);
    }
    #[cfg(windows)]
    if !named {
        return crate::codex_peer::windows_executable()
            .ok()
            .as_deref()
            .and_then(cli_for_desktop);
    }
    let _ = named;
    None
}

async fn expired(mut lease: watch::Receiver<Instant>) {
    loop {
        let deadline = *lease.borrow_and_update();
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return,
            changed = lease.changed() => {
                if changed.is_err() {
                    // Dropping the sender also cancels the call. Let the
                    // cancellation path send its stop request.
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

struct Connection {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    buffer: Vec<u8>,
}

impl Connection {
    fn spawn(program: &Path, home: &Path) -> Result<Self> {
        let mut command = Command::new(program);
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "--disable",
                "apps",
                "--disable",
                "plugins",
                "--disable",
                "hooks",
            ])
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn()?;
        Ok(Self {
            input: child.stdin.take().context("missing app-server stdin")?,
            output: BufReader::new(child.stdout.take().context("missing app-server stdout")?),
            _child: child,
            buffer: Vec::new(),
        })
    }

    async fn send(&mut self, value: Value) -> Result<()> {
        let message = serde_json::to_string(&value)?;
        self.input.write_all(message.as_bytes()).await?;
        self.input.write_all(b"\n").await?;
        self.input.flush().await?;
        Ok(())
    }

    async fn read(&mut self) -> Result<Value> {
        let remaining = MAX_MESSAGE.saturating_sub(self.buffer.len());
        (&mut self.output)
            .take(remaining as u64)
            .read_until(b'\n', &mut self.buffer)
            .await?;
        ensure!(
            self.buffer.last() == Some(&b'\n'),
            "incomplete app-server message"
        );
        let value = serde_json::from_slice(&self.buffer);
        self.buffer.clear();
        Ok(value?)
    }
}

struct AppServer<'a> {
    connection: &'a mut Connection,
    next_id: u64,
}

impl<'a> AppServer<'a> {
    fn new(connection: &'a mut Connection) -> Self {
        Self {
            connection,
            next_id: 0,
        }
    }

    async fn send_request(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.connection
            .send(json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        timeout(CALL_TIMEOUT, async {
            let id = self.send_request(method, params).await?;
            loop {
                let value = self.connection.read().await?;
                if value["id"] == id {
                    return rpc_result(value);
                }
            }
        })
        .await?
    }

    async fn prepare(&mut self, thread: Uuid, cwd: &Path) -> Result<Uuid> {
        self.request(
            "initialize",
            json!({
                "clientInfo":{"name":"agent_space_codex_voice","title":"Agent Space","version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"experimentalApi":true}
            }),
        )
        .await?;
        self.connection
            .send(json!({"method":"initialized"}))
            .await?;
        self.request("thread/realtime/listVoices", json!({}))
            .await
            .context(Failure("当前 Codex 版本未提供实时语音接口"))?;
        // The local command sandbox does not constrain external MCP tools.
        let config = self
            .request("config/read", json!({"cwd":cwd,"includeLayers":false}))
            .await
            .context(Failure("无法确认语音分支的工具权限"))?;
        let config = fork_tool_overrides(&config)?;
        let fork = self
            .request(
                "thread/fork",
                json!({
                    "threadId":thread,"cwd":cwd,"threadSource":"user","excludeTurns":true,
                    "deferGoalContinuation":true,"sandbox":"read-only","approvalPolicy":"never",
                    "config":config
                }),
            )
            .await
            .context(Failure("无法从已保存的 Codex 会话创建语音分支"))?;
        readonly_fork(thread, &fork)
    }

    async fn begin(
        &mut self,
        session: Uuid,
        offer: &str,
        notifications: &mut Notifications<'_>,
        accepted: &mut bool,
    ) -> Result<()> {
        let id = self
            .send_request(
                "thread/realtime/start",
                json!({
                    "threadId":notifications.thread,
                    "outputModality":"audio",
                    "version":"v3",
                    "voiceSessionId":session,
                    "transport":{"type":"webrtc","sdp":offer},
                }),
            )
            .await?;
        while !*accepted || !notifications.connected() {
            let value = self.connection.read().await?;
            if value["id"] == id {
                rpc_result(value)
                    .context(Failure("Codex 拒绝开启语音，请检查登录状态和语音可用性"))?;
                *accepted = true;
            } else {
                notifications.handle(value)?;
                ensure!(
                    !notifications.closed,
                    Failure("Codex 已关闭语音，请检查登录状态和语音可用性")
                );
            }
        }
        Ok(())
    }

    async fn listen(&mut self, notifications: &mut Notifications<'_>) -> Result<()> {
        while !notifications.closed {
            notifications.handle(self.connection.read().await?)?;
        }
        Ok(())
    }
}

fn fork_tool_overrides(config: &Value) -> Result<serde_json::Map<String, Value>> {
    let config = config["config"]
        .as_object()
        .context(Failure("无法确认语音分支的工具权限"))?;
    let mut overrides = serde_json::Map::new();
    if let Some(servers) = config
        .get("mcp_servers")
        .filter(|servers| !servers.is_null())
    {
        let servers = servers
            .as_object()
            .context(Failure("无法确认语音分支的工具权限"))?;
        for name in servers.keys() {
            let name = serde_json::to_string(name)?;
            overrides.insert(format!("mcp_servers.{name}.enabled"), json!(false));
        }
    }
    Ok(overrides)
}

fn readonly_fork(thread: Uuid, fork: &Value) -> Result<Uuid> {
    ensure!(
        fork["thread"]["forkedFromId"] == thread.to_string()
            && fork["sandbox"]["type"] == "readOnly"
            && fork["sandbox"]["networkAccess"] == false
            && fork["approvalPolicy"] == "never",
        Failure("无法确认语音分支使用只读权限")
    );
    let id = fork["thread"]["id"].as_str().context("missing fork id")?;
    let id = Uuid::parse_str(id)?;
    ensure!(id != thread, "fork equals parent thread");
    Ok(id)
}

fn rpc_result(value: Value) -> Result<Value> {
    value
        .get("result")
        .cloned()
        .context("app-server rejected request")
}

struct Notifications<'a> {
    thread: Uuid,
    events: &'a mpsc::Sender<Value>,
    started: bool,
    answer: bool,
    closed: bool,
    transcripts: [String; 2],
}

impl<'a> Notifications<'a> {
    fn new(thread: Uuid, events: &'a mpsc::Sender<Value>) -> Self {
        Self {
            thread,
            events,
            started: false,
            answer: false,
            closed: false,
            transcripts: Default::default(),
        }
    }

    fn connected(&self) -> bool {
        self.started && self.answer
    }

    fn handle(&mut self, value: Value) -> Result<()> {
        let params = &value["params"];
        if value.get("id").is_some() || params["threadId"] != self.thread.to_string() {
            return Ok(());
        }
        match value["method"].as_str() {
            Some("thread/realtime/started") if !self.started => {
                self.started = true;
                self.emit(json!({"type":"started","voiceThreadId":self.thread}))?;
            }
            Some("thread/realtime/sdp") if !self.answer => {
                let sdp = params["sdp"]
                    .as_str()
                    .filter(|value| voice_sdp(value))
                    .context("invalid app-server SDP")?;
                self.answer = true;
                self.emit(json!({"type":"answer","sdp":sdp}))?;
            }
            Some("thread/realtime/transcript/delta") => self.transcript(params, false)?,
            Some("thread/realtime/transcript/done") => self.transcript(params, true)?,
            Some("thread/realtime/error") => {
                bail!(Failure("Codex 语音发生错误，请检查账号语音权限或重试"))
            }
            Some("thread/realtime/closed") => {
                self.closed = true;
                self.emit(json!({"type":"closed"}))?;
            }
            _ => {}
        }
        Ok(())
    }

    fn transcript(&mut self, params: &Value, done: bool) -> Result<()> {
        let role = match params["role"].as_str() {
            Some(role @ ("user" | "assistant")) => role,
            _ => return Ok(()),
        };
        let index = usize::from(role == "assistant");
        let text = &mut self.transcripts[index];
        if done {
            text.clear();
        }
        let field = if done { "text" } else { "delta" };
        let Some(delta) = params[field].as_str() else {
            return Ok(());
        };
        let remaining = MAX_TRANSCRIPT.saturating_sub(text.len());
        text.push_str(&delta[..delta.floor_char_boundary(remaining.min(delta.len()))]);
        let event = json!({"type":"transcript","role":role,"text":text,"final":done});
        if done {
            text.clear();
            self.emit(event)
        } else {
            // A final transcript is sent separately, even if the client cannot keep up with deltas.
            let _ = self.events.try_send(event);
            Ok(())
        }
    }

    fn emit(&self, value: Value) -> Result<()> {
        self.events.try_send(value)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_fork_checks_source_and_effective_permissions() {
        let source = Uuid::new_v4();
        let fork = Uuid::new_v4();
        let mut response = json!({
            "thread":{"id":fork,"forkedFromId":source},
            "sandbox":{"type":"readOnly","networkAccess":false},
            "approvalPolicy":"never"
        });
        assert_eq!(readonly_fork(source, &response).unwrap(), fork);
        response["sandbox"]["networkAccess"] = json!(true);
        assert!(readonly_fork(source, &response).is_err());
        response["sandbox"]["networkAccess"] = json!(false);
        response["thread"]["id"] = json!(source);
        assert!(readonly_fork(source, &response).is_err());
    }

    #[test]
    fn fork_disables_named_and_project_mcp_servers() {
        let config = json!({"config":{"mcp_servers":{"a.b":{"enabled":true},"c":{}}}});
        assert_eq!(
            Value::Object(fork_tool_overrides(&config).unwrap()),
            json!({"mcp_servers.\"a.b\".enabled":false,"mcp_servers.\"c\".enabled":false})
        );
        assert!(fork_tool_overrides(&json!({"config":{"mcp_servers":true}})).is_err());
    }

    #[test]
    fn filters_notices_by_thread_and_finalizes_transcript_segments() {
        let id = Uuid::new_v4();
        let (events, mut received) = mpsc::channel(8);
        let mut notifications = Notifications::new(id, &events);
        for (thread, method, role, text) in [
            (Uuid::new_v4(), "delta", "assistant", "other"),
            (id, "delta", "user", "你好"),
            (id, "delta", "user", "，Codex"),
            (id, "done", "user", "你好，Codex。"),
            (id, "delta", "user", "继续"),
        ] {
            notifications
                .handle(json!({
                    "method": format!("thread/realtime/transcript/{method}"),
                    "params":{"threadId":thread,"role":role,"delta":text,"text":text}
                }))
                .unwrap();
        }
        assert_eq!(received.try_recv().unwrap()["text"], "你好");
        assert_eq!(received.try_recv().unwrap()["text"], "你好，Codex");
        assert_eq!(received.try_recv().unwrap()["final"], true);
        assert_eq!(received.try_recv().unwrap()["text"], "继续");
        assert!(received.try_recv().is_err());
    }
}
