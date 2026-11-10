use crate::{
    im_agent::Handler,
    im_client::{Client, required},
    im_crypto::Envelope,
    plugin_host::Process,
    update::UpdateGate,
};
use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PRESENCE: Duration = Duration::from_secs(30);
const HEARTBEAT: Duration = Duration::from_secs(20);

pub(crate) fn cli(args: &[String]) -> Result<()> {
    const USAGE: &str = "用法: agent-space-native --im-call --state 凭据文件 --handler 原生处理程序 [--environment-file 环境文件]";
    let mut state = None;
    let mut handler = None;
    let mut environment = None;
    let mut args = args.iter();
    while let Some(option) = args.next() {
        let (name, value) = match option.split_once('=') {
            Some((name, value)) => (name, value),
            None => (
                option.as_str(),
                args.next().map(String::as_str).context(USAGE)?,
            ),
        };
        let slot = match name {
            "--state" => &mut state,
            "--handler" => &mut handler,
            "--environment-file" => &mut environment,
            _ => anyhow::bail!(USAGE),
        };
        ensure!(slot.is_none() && !value.is_empty(), USAGE);
        *slot = Some(std::path::absolute(value)?);
    }
    let state = state.context(USAGE)?;
    let handler = handler.context(USAGE)?;
    let environment = environment.as_deref();
    Client::load(&state)?;
    Handler::load(&handler, environment)?;

    tokio::runtime::Runtime::new()?.block_on(async {
        let stop = CancellationToken::new();
        let last = std::cell::Cell::new(None);
        let listener = supervise(
            &handler,
            &state,
            environment,
            UpdateGate::default(),
            stop.clone(),
            |online| {
                if last.replace(Some(online)) != Some(online) {
                    eprintln!("Agent calls: {}", if online { "ready" } else { "offline" });
                }
            },
        );
        tokio::pin!(listener);
        tokio::select! {
            _ = &mut listener => Ok(()),
            signal = termination() => {
                stop.cancel();
                let _ = timeout(Duration::from_secs(12), listener).await;
                signal
            }
        }
    })
}

async fn termination() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

pub(crate) async fn supervise(
    handler: &Path,
    state: &Path,
    environment: Option<&Path>,
    gate: UpdateGate,
    stop: CancellationToken,
    online: impl Fn(bool),
) {
    while !stop.is_cancelled() {
        let _ = listen(handler, state, environment, &gate, &stop, &online).await;
        online(false);
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn listen(
    handler: &Path,
    state: &Path,
    environment: Option<&Path>,
    gate: &UpdateGate,
    stop: &CancellationToken,
    online: &impl Fn(bool),
) -> Result<()> {
    let client = Client::load(state)?;
    let mut process = Process::spawn(Handler::load(handler, environment)?.command()?)?;
    let mut advertised = None;
    let result = async {
        let ready = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            result = async {
                client.verify().await?;
                plugin(&mut process, "call/check", json!({"sdk":1})).await
            } => result?,
        };
        ensure!(
            ready["sdk"] == 1 && ready["audio"] == true,
            "独立 Agent 通话处理程序能力无效"
        );
        let video = ready["video"] == true;
        while !stop.is_cancelled() {
            let pending = tokio::select! {
                _ = stop.cancelled() => break,
                result = async {
                    refresh(&client, video, &mut advertised).await?;
                    client.get("/calls").await
                } => result?,
            };
            online(true);
            let calls = pending["calls"]
                .as_array()
                .context("独立 Agent 来电列表无效")?;
            if let Some(call) = calls
                .iter()
                .find(|call| call["state"] == "ringing" && call["agentId"] == client.id)
                && let Some(_active) = gate.admit()
            {
                let call_id = required(call, "id")?;
                ensure!(Uuid::parse_str(call_id).is_ok(), "独立 Agent 通话标识无效");
                let session = Call {
                    client: &client,
                    wire: call,
                    path: format!("/calls/{call_id}"),
                    video,
                };
                session.answer(&mut process, &mut advertised, stop).await?;
            }
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = sleep(Duration::from_secs(1)) => {}
            }
        }
        Ok(())
    }
    .await;
    if advertised.is_some() {
        let _ = timeout(Duration::from_secs(2), presence(&client, false, false)).await;
    }
    let _ = process.stop().await;
    result
}

async fn presence(client: &Client, video: bool, available: bool) -> Result<()> {
    client
        .request(
            Method::PUT,
            "/calls/presence",
            Some(&json!({"video":video,"available":available})),
        )
        .await?;
    Ok(())
}

async fn refresh(client: &Client, video: bool, advertised: &mut Option<Instant>) -> Result<()> {
    if advertised.is_none_or(|when| when.elapsed() >= PRESENCE) {
        // Record the attempt so shutdown also clears an acknowledged request whose response was lost.
        *advertised = Some(Instant::now());
        presence(client, video, true).await?;
    }
    Ok(())
}

struct Call<'a> {
    client: &'a Client,
    wire: &'a Value,
    path: String,
    video: bool,
}

impl Call<'_> {
    async fn answer(
        &self,
        process: &mut Process,
        advertised: &mut Option<Instant>,
        stop: &CancellationToken,
    ) -> Result<()> {
        let result = tokio::select! {
            _ = stop.cancelled() => Ok("hangup"),
            result = self.negotiate(process, advertised) => result,
        };
        let reason = result.as_ref().copied().unwrap_or("failed");
        let _ = timeout(Duration::from_secs(2), self.update("end", Some(reason))).await;
        if result.is_ok() && !stop.is_cancelled() {
            plugin(process, "call/close", json!({"reason":reason})).await?;
        } else {
            process.stop().await?;
        }
        result.map(|_| ())
    }

    async fn negotiate(
        &self,
        process: &mut Process,
        advertised: &mut Option<Instant>,
    ) -> Result<&'static str> {
        if self.wire["mode"] == "video" && !self.video {
            return Ok("declined");
        }
        let ice = self.client.get("/calls/ice").await?;
        ensure!(ice["iceServers"].is_array(), "独立 Agent ICE 配置无效");
        let setup = timeout(
            Duration::from_secs(20),
            process.request(
                "call/open",
                json!({"call":self.wire,"iceServers":ice["iceServers"]}),
            ),
        )
        .await??;
        match setup["accepted"].as_bool() {
            Some(true) => {}
            Some(false) => return Ok("declined"),
            None => anyhow::bail!("独立 Agent 通话处理程序未确认"),
        }
        if self.update("accept", None).await?["call"]["state"] != "active" {
            return Ok("hangup");
        }
        let caller = required(self.wire, "callerId")?;
        let agent = self.client.id.as_str();
        ensure!(caller != agent, "独立 Agent 通话参与者无效");
        let id = required(self.wire, "id")?;
        let mut after = 0;
        let mut heartbeat = Instant::now();
        let mut has_offer = false;
        let mut pending = Vec::new();
        loop {
            let result = self
                .client
                .get(&format!("{}?after={after}", self.path))
                .await?;
            if result["call"]["state"] == "ended" {
                return Ok("hangup");
            }
            let signals = result["signals"]
                .as_array()
                .context("独立 Agent 通话信令无效")?;
            for item in signals.iter().filter(|item| item["senderId"] == caller) {
                let message = required(item, "id")?;
                ensure!(
                    Uuid::parse_str(message).is_ok(),
                    "独立 Agent 通话信令标识无效"
                );
                let envelope = Envelope::parse(required(item, "encrypted")?)?;
                let recipients = envelope.recipients();
                ensure!(
                    recipients.len() == 2
                        && recipients.contains_key(caller)
                        && recipients.contains_key(agent),
                    "独立 Agent 通话信令参与者无效"
                );
                let signal = self
                    .client
                    .decrypt(caller, &format!("call:{id}:{message}"), envelope)
                    .await?;
                let description = validate_signal(&signal, "offer")?;
                if !description && !has_offer {
                    ensure!(pending.len() < 128, "独立 Agent 通话候选项过多");
                    pending.push(signal);
                    continue;
                }
                let response = plugin(process, "call/signal", json!({"signal":signal})).await?;
                self.outgoing(response, caller, agent, id).await?;
                if description {
                    has_offer = true;
                    for candidate in pending.drain(..) {
                        let response =
                            plugin(process, "call/signal", json!({"signal":candidate})).await?;
                        self.outgoing(response, caller, agent, id).await?;
                    }
                }
            }
            after = result["cursor"]
                .as_u64()
                .filter(|value| *value >= after)
                .context("独立 Agent 通话游标无效")?;
            let response = plugin(process, "call/poll", json!({})).await?;
            let connected = response["connected"] == true;
            self.outgoing(response, caller, agent, id).await?;
            if heartbeat.elapsed() >= HEARTBEAT {
                self.update("heartbeat", None).await?;
                heartbeat = Instant::now();
            }
            refresh(self.client, self.video, advertised).await?;
            sleep(Duration::from_millis(if connected { 1000 } else { 350 })).await;
        }
    }

    async fn update(&self, action: &str, reason: Option<&str>) -> Result<Value> {
        let mut body = json!({"action":action});
        if let Some(reason) = reason {
            body["reason"] = json!(reason);
        }
        self.client
            .request(Method::PATCH, &self.path, Some(&body))
            .await
    }

    async fn outgoing(
        &self,
        response: Value,
        caller: &str,
        agent: &str,
        call_id: &str,
    ) -> Result<()> {
        ensure!(
            response.is_object() && response["failed"] != true,
            "独立 Agent 媒体连接失败"
        );
        let Some(signals) = response["signals"].as_array() else {
            ensure!(response["signals"].is_null(), "独立 Agent 通话信令列表无效");
            return Ok(());
        };
        ensure!(signals.len() <= 128, "独立 Agent 通话信令过多");
        let endpoint = format!("{}/signals", self.path);
        for signal in signals {
            validate_signal(signal, "answer")?;
            let id = Uuid::new_v4();
            let encrypted = self
                .client
                .encrypt(&[caller, agent], &format!("call:{call_id}:{id}"), signal)
                .await?;
            self.client
                .request(
                    Method::POST,
                    &endpoint,
                    Some(&json!({"id":id,"encrypted":encrypted})),
                )
                .await?;
        }
        Ok(())
    }
}

async fn plugin(process: &mut Process, method: &str, params: Value) -> Result<Value> {
    timeout(Duration::from_secs(5), process.request(method, params)).await?
}

fn validate_signal(signal: &Value, role: &str) -> Result<bool> {
    match signal["type"].as_str() {
        Some("description") => {
            let description = &signal["description"];
            ensure!(
                description["type"] == role
                    && description["sdp"]
                        .as_str()
                        .is_some_and(|sdp| !sdp.is_empty() && sdp.len() <= 48 * 1024),
                "独立 Agent SDP 无效"
            );
            Ok(true)
        }
        Some("candidate") => {
            ensure!(
                signal["candidate"]["candidate"]
                    .as_str()
                    .is_some_and(|value| value.len() <= 4096),
                "独立 Agent ICE candidate 无效"
            );
            Ok(false)
        }
        _ => anyhow::bail!("独立 Agent 通话信令无效"),
    }
}
