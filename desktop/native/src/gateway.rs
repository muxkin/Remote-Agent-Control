use crate::{
    codex_backend::Group,
    device::{Backends, DeviceSession},
    state::{Device, Pairing, Route, Store, hash, now},
    update::{Client, UpdateGate},
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::{AsyncReadExt as _, AsyncWriteExt as _, SinkExt as _, StreamExt as _};
use libp2p_core::upgrade::InboundConnectionUpgrade;
use libp2p_identity::{Keypair, PeerId};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream},
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{interval, sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};
use tokio_util::compat::TokioAsyncReadCompatExt;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lane {
    Control,
    Bulk,
}

impl Lane {
    fn name(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Bulk => "bulk",
        }
    }
}

pub(crate) struct Packet {
    pub value: Value,
    pub bytes: Vec<u8>,
}
const FRAME_PREFIX: usize = 36;
const MAX_WIRE: usize = 65_536;
const MAX_PACKET: usize = 16 * 1024 * 1024;

pub type Database = Arc<Mutex<Store>>;

#[derive(Clone, Default, PartialEq)]
pub struct Snapshot {
    pub phase: Phase,
    pub pairing: Option<DisplayPairing>,
    pub history: bool,
    pub agents: Vec<ManagedAgent>,
    pub update: String,
    pub(crate) update_preferences: Option<crate::update_preferences::Preferences>,
    pub(crate) update_checking: bool,
    pub manual_update: bool,
    pub exit_for_update: bool,
}

#[derive(Clone, PartialEq, Deserialize)]
pub struct ManagedAgent {
    pub name: String,
    pub connected: bool,
}

#[derive(Clone, Default, PartialEq)]
pub enum Phase {
    #[default]
    Setup,
    Connecting,
    Online,
    Unavailable,
}

#[derive(Clone, PartialEq)]
pub struct DisplayPairing {
    pub link: String,
    pub expires_at: i64,
}

pub struct RelayConfig {
    pub origin: Url,
    pub enrollment: String,
    pub codex: Group,
    pub direct: Option<crate::direct::Direct>,
    pub storage: Option<crate::storage::Storage>,
    pub plugins: crate::plugins::Registry,
}

impl RelayConfig {
    pub fn new(origin: &str, enrollment: String) -> Result<Self> {
        let origin = Url::parse(origin).context("服务地址无效")?;
        let loopback = matches!(origin.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure!(
            (origin.scheme() == "https" || (origin.scheme() == "http" && loopback))
                && origin.path() == "/"
                && origin.host_str().is_some()
                && origin.query().is_none()
                && origin.fragment().is_none()
                && origin.username().is_empty()
                && origin.password().is_none(),
            "请输入 HTTPS 服务地址"
        );
        ensure!(enrollment.len() <= 512, "接入密钥过长");
        Ok(Self {
            origin,
            enrollment,
            codex: Group::default(),
            direct: None,
            storage: None,
            plugins: Default::default(),
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum RelayMessage {
    Challenge { challenge: String },
    Registered { protocol: u32 },
    Join { id: Uuid, ticket: String },
    Leave { id: Uuid },
}

struct Wire {
    inbound: mpsc::Sender<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.task.abort();
    }
}

enum WireEvent {
    Bytes(Uuid, Vec<u8>),
    Closed(Uuid),
}

pub async fn run(
    config: RelayConfig,
    db: Database,
    generate: mpsc::Receiver<()>,
    state: watch::Sender<Snapshot>,
    gate: UpdateGate,
) {
    let (_unused, bulk) = mpsc::channel(1);
    let (bulk_state, _receiver) = watch::channel(Snapshot::default());
    tokio::select! {
        _ = run_lane(&config, &db, Lane::Control, generate, state, &gate) => {}
        _ = run_lane(&config, &db, Lane::Bulk, bulk, bulk_state, &gate) => {}
    }
}

async fn run_lane(
    config: &RelayConfig,
    db: &Database,
    lane: Lane,
    mut generate: mpsc::Receiver<()>,
    state: watch::Sender<Snapshot>,
    gate: &UpdateGate,
) {
    let identity = db.lock().expect("database mutex poisoned").identity.clone();
    let mut pairing = None;
    let mut delay = Duration::from_millis(500);
    loop {
        state.send_modify(|current| {
            current.phase = Phase::Connecting;
            current.history = config.codex.has_history();
        });
        let result = run_connection(
            config,
            &identity,
            db,
            lane,
            &mut generate,
            &state,
            &mut pairing,
            gate,
        )
        .await;
        if result.is_ok() || generate.is_closed() {
            return;
        }
        if state.borrow().phase == Phase::Online {
            delay = Duration::from_millis(500);
        }
        state.send_modify(|current| current.phase = Phase::Unavailable);
        while generate.try_recv().is_ok() {}
        sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(15));
    }
}

async fn run_connection(
    config: &RelayConfig,
    identity: &Keypair,
    db: &Database,
    lane: Lane,
    generate: &mut mpsc::Receiver<()>,
    state: &watch::Sender<Snapshot>,
    pairing: &mut Option<Pairing>,
    gate: &UpdateGate,
) -> Result<()> {
    let mut url = config.origin.join("/connect")?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| anyhow::anyhow!("无法构造中继地址"))?;
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Origin",
        HeaderValue::from_str(&config.origin.origin().ascii_serialization())?,
    );
    let limits = WebSocketConfig::default()
        .max_message_size(Some(128 * 1024))
        .max_frame_size(Some(128 * 1024))
        .max_write_buffer_size(2 * 1024 * 1024);
    let host = identity.public().to_peer_id();
    let mut socket = timeout(Duration::from_secs(10), async {
        let (mut socket, _) = connect_async_with_config(request, Some(limits), false).await?;
        let Some(Ok(Message::Text(value))) = socket.next().await else {
            bail!("中继未发送挑战")
        };
        let RelayMessage::Challenge { challenge } = serde_json::from_str(&value)? else {
            bail!("中继挑战无效")
        };
        let proof = format!(
            "codex-pocket/2/relay-host\n{challenge}\n{host}\n{}",
            lane.name()
        );
        let signature = STANDARD.encode(identity.sign(proof.as_bytes())?);
        socket
            .send(text(json!({
                "type": "host", "hostId": host.to_string(), "lane": lane.name(),
                "signature": signature, "enrollment": config.enrollment,
            })))
            .await?;
        let Some(Ok(Message::Text(value))) = socket.next().await else {
            bail!("中继拒绝注册")
        };
        ensure!(
            matches!(
                serde_json::from_str(&value)?,
                RelayMessage::Registered { protocol: 2 }
            ),
            "中继版本不兼容"
        );
        Ok::<_, anyhow::Error>(socket)
    })
    .await??;
    let mut routes = read_routes(db)?;
    if lane == Lane::Control {
        let directory = db
            .lock()
            .expect("database mutex poisoned")
            .directory
            .clone();
        // The same enrolled device can reconnect without persisting the enrollment secret.
        let _ = crate::state::remember_origin(
            &directory,
            &config.origin.origin().ascii_serialization(),
        );
        send(
            &mut socket,
            text(json!({"type": "routes", "routes": routes})),
        )
        .await?;
    }
    state.send_modify(|current| current.phase = Phase::Online);
    let mut wires = HashMap::<Uuid, Wire>::new();
    let (outgoing, mut events) = mpsc::channel(64);
    let mut tick = interval(Duration::from_secs(1));
    let mut ping = interval(Duration::from_secs(15));
    let mut received = tokio::time::Instant::now();

    loop {
        tokio::select! {
            command = generate.recv(), if lane == Lane::Control => {
                if command.is_none() {
                    return Ok(());
                }
                let next = db.lock().expect("database mutex poisoned").mint_pairing(pairing.as_ref())?;
                state.send_modify(|current| current.pairing = None);
                let mut link = config.origin.clone();
                link.set_fragment(Some(&format!("pair={}&host={host}", next.code)));
                *pairing = Some(next.clone());
                routes = read_routes(db)?;
                send(&mut socket, text(json!({"type": "routes", "routes": routes}))).await?;
                state.send_modify(|current| current.pairing = Some(DisplayPairing {
                    link: link.into(), expires_at: next.expires_at
                }));
            }
            _ = tick.tick(), if lane == Lane::Control => {
                let next = read_routes(db)?;
                if next != routes {
                    send(&mut socket, text(json!({"type": "routes", "routes": next}))).await?;
                    routes = next;
                }
                if let Some(active) = pairing {
                    if active.expires_at <= now() || !db.lock().expect("database mutex poisoned").pairing_pending(active)? {
                        state.send_modify(|current| current.pairing = None);
                        *pairing = None;
                    }
                }
            }
            _ = ping.tick() => {
                ensure!(received.elapsed() < Duration::from_secs(45), "中继响应超时");
                send(&mut socket, Message::Ping(Default::default())).await?;
            }
            Some(event) = events.recv() => match event {
                WireEvent::Bytes(id, bytes) if wires.contains_key(&id) => {
                    let mut frame = Vec::with_capacity(FRAME_PREFIX + bytes.len());
                    frame.extend_from_slice(id.to_string().as_bytes());
                    frame.extend_from_slice(&bytes);
                    send(&mut socket, Message::Binary(frame.into())).await?;
                }
                WireEvent::Closed(id) => close_wire(&mut socket, &mut wires, id).await?,
                _ => {}
            },
            message = socket.next() => {
                received = tokio::time::Instant::now();
                match message.context("中继已断开")?? {
                    Message::Text(value) => match serde_json::from_str(&value)? {
                        RelayMessage::Join { id, ticket } => {
                            let routes = read_routes(db)?;
                            let route = routes.iter().find(|route| route.ticket == ticket && route.expires > now()
                                && (lane == Lane::Control || route.peer_id.is_some()));
                            if let Some(route) = route.filter(|_| wires.len() < 32 && !wires.contains_key(&id))
                                && let Some(client) = gate.admit()
                            {
                                wires.insert(id, spawn_wire(id, route.clone(), db.clone(), identity.clone(), lane, Backends { codex: config.codex.clone(), direct: config.direct.clone(), storage: config.storage.clone(), update_gate: gate.clone(), plugins: config.plugins.clone() }, outgoing.clone(), client));
                            } else if !wires.contains_key(&id) {
                                send(&mut socket, text(json!({"type": "close", "id": id}))).await?;
                            }
                        }
                        RelayMessage::Leave { id } => { wires.remove(&id); }
                        _ => bail!("中继消息顺序无效"),
                    },
                    Message::Binary(frame) => {
                        ensure!((FRAME_PREFIX + 1..=FRAME_PREFIX + MAX_WIRE).contains(&frame.len()), "中继帧大小无效");
                        let id = Uuid::try_parse_ascii(&frame[..FRAME_PREFIX])?;
                        if let Some(wire) = wires.get(&id) {
                            // The relay can deliver a file block in a burst of encrypted frames.
                            // Let this peer drain its bounded queue before treating it as stalled.
                            if wire.inbound.send_timeout(frame[FRAME_PREFIX..].to_vec(), Duration::from_millis(500)).await.is_err() {
                                close_wire(&mut socket, &mut wires, id).await?;
                            }
                        }
                    }
                    Message::Close(_) => bail!("中继已关闭"),
                    Message::Ping(_) => timeout(Duration::from_secs(5), socket.flush()).await??,
                    _ => {}
                }
            }
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn read_routes(db: &Database) -> Result<Vec<Route>> {
    db.lock().expect("database mutex poisoned").routes()
}

fn text(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

async fn send(socket: &mut Socket, message: Message) -> Result<()> {
    timeout(Duration::from_secs(5), socket.send(message)).await??;
    Ok(())
}

async fn close_wire(socket: &mut Socket, wires: &mut HashMap<Uuid, Wire>, id: Uuid) -> Result<()> {
    if wires.remove(&id).is_some() {
        send(socket, text(json!({"type": "close", "id": id}))).await?;
    }
    Ok(())
}

fn spawn_wire(
    id: Uuid,
    route: Route,
    db: Database,
    identity: Keypair,
    lane: Lane,
    backends: Backends,
    events: mpsc::Sender<WireEvent>,
    client: Client,
) -> Wire {
    let (inbound, mut from_relay) = mpsc::channel::<Vec<u8>>(8);
    let (transport, session) = tokio::io::duplex(128 * 1024);
    let task = tokio::spawn(async move {
        let _client = client;
        let (mut output, mut input) = tokio::io::split(transport);
        let outgoing = async {
            let mut buffer = vec![0; 16 * 1024];
            loop {
                let length = output.read(&mut buffer).await?;
                if length == 0
                    || events
                        .send(WireEvent::Bytes(id, buffer[..length].to_vec()))
                        .await
                        .is_err()
                {
                    break;
                }
            }
            Ok::<_, std::io::Error>(())
        };
        let incoming = async {
            while let Some(bytes) = from_relay.recv().await {
                input.write_all(&bytes).await?;
            }
            Ok::<_, std::io::Error>(())
        };
        tokio::select! {
            _ = serve(session, route, db, identity, lane, backends, None) => {}
            _ = outgoing => {}
            _ = incoming => {}
        }
        let _ = events.send(WireEvent::Closed(id)).await;
    });
    Wire { inbound, task }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Auth {
    Pair {
        protocol: u32,
        #[serde(rename = "sessionId")]
        session_id: Uuid,
        name: String,
        code: String,
    },
    Authenticate {
        protocol: u32,
        #[serde(rename = "sessionId")]
        session_id: Uuid,
    },
}

async fn serve(
    transport: DuplexStream,
    route: Route,
    db: Database,
    identity: Keypair,
    lane: Lane,
    backends: Backends,
    expected_session: Option<Uuid>,
) -> Result<()> {
    let noise = libp2p_noise::Config::new(&identity)?
        .with_prologue(format!("codex-pocket/2/{}", lane.name()).into_bytes());
    let (peer, mut io) = timeout(
        Duration::from_secs(10),
        noise.upgrade_inbound(transport.compat(), "/noise"),
    )
    .await??;
    if let Some(expected) = &route.peer_id {
        ensure!(expected.parse::<PeerId>()? == peer, "设备身份不匹配");
    }
    let auth = timeout(Duration::from_secs(10), packet(&mut io)).await??;
    ensure!(auth.bytes.is_empty(), "设备认证格式无效");
    let auth = serde_json::from_value(auth.value)?;
    if let Some(expected) = expected_session {
        ensure!(
            matches!(&auth, Auth::Authenticate { session_id, .. } if *session_id == expected),
            "直连会话不匹配"
        );
    }
    let (session, device) = authenticate(&db, peer, &route, auth)?;
    if lane == Lane::Control {
        backends.codex.refresh().await;
    }
    let stun = backends
        .direct
        .as_ref()
        .map_or(&[][..], |direct| direct.stun.as_slice());
    reply(
        &mut io,
        json!({
            "type": "ready", "protocol": 2, "sessionId": session,
            "device": {"id": device.id, "name": device.name}, "ticket": device.ticket,
            "hostName": "Agent 空间 · 原生", "status": backends.codex.main().status(false),
            "p2p": {"enabled": backends.direct.is_some(), "stunUrls": stun},
        }),
    )
    .await?;

    let (mut reader, mut writer) = io.split();
    let (send, receive) = mpsc::channel(4);
    let incoming = async {
        loop {
            let message = packet(&mut reader).await?;
            send.send(message).await.context("设备已断开")?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! {
        result = incoming => result,
        result = DeviceSession::new(db, peer, device, backends, lane == Lane::Bulk, (lane == Lane::Control && expected_session.is_none()).then_some(session)).run(receive, &mut writer) => result,
    }
}

pub(crate) fn direct_serve(
    transport: DuplexStream,
    route: Route,
    db: Database,
    identity: Keypair,
    lane: Lane,
    backends: Backends,
    session: Uuid,
) -> futures::future::BoxFuture<'static, Result<()>> {
    Box::pin(async move {
        let _client = backends.update_gate.admit().context("适配器正在安装更新")?;
        serve(
            transport,
            route,
            db,
            identity,
            lane,
            backends,
            Some(session),
        )
        .await
    })
}

fn authenticate(db: &Database, peer: PeerId, route: &Route, auth: Auth) -> Result<(Uuid, Device)> {
    let mut store = db.lock().expect("database mutex poisoned");
    let session = match auth {
        Auth::Pair {
            protocol: 2,
            session_id,
            code,
            name,
        } if route.peer_id.is_none() => {
            let name = name.trim();
            ensure!(
                (1..=80).contains(&name.encode_utf16().count()) && (20..=128).contains(&code.len()),
                "配对参数无效"
            );
            ensure!(hash(&code) == route.ticket, "配对码无效");
            store.pair(&route.ticket, name, peer)?;
            session_id
        }
        Auth::Authenticate {
            protocol: 2,
            session_id,
        } if route.peer_id.is_some() => session_id,
        _ => bail!("会话认证无效"),
    };
    let device = store.device(peer)?.context("设备已撤销")?;
    ensure!(
        route.peer_id.is_none() || device.ticket == route.ticket,
        "配对票据已更换"
    );
    Ok((session, device))
}

async fn packet(io: &mut (impl futures::AsyncRead + Unpin)) -> Result<Packet> {
    let mut header = [0; 4];
    io.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header) as usize;
    ensure!(
        (6..=crate::files::BLOCK + 64 * 1024).contains(&size),
        "请求大小无效"
    );
    io.read_exact(&mut header).await?;
    let json = u32::from_be_bytes(header) as usize;
    ensure!(
        (2..=64 * 1024).contains(&json)
            && json <= size - 4
            && size - 4 - json <= crate::files::BLOCK,
        "请求格式无效"
    );
    let mut data = vec![0; json];
    io.read_exact(&mut data).await?;
    let value: Value = serde_json::from_slice(&data)?;
    ensure!(value.is_object(), "请求格式无效");
    let mut bytes = vec![0; size - 4 - json];
    io.read_exact(&mut bytes).await?;
    Ok(Packet { value, bytes })
}

pub(crate) async fn reply(io: &mut (impl futures::AsyncWrite + Unpin), value: Value) -> Result<()> {
    reply_packet(io, value, &[]).await
}

pub(crate) async fn reply_packet(
    io: &mut (impl futures::AsyncWrite + Unpin),
    value: Value,
    data: &[u8],
) -> Result<()> {
    let bytes = serde_json::to_vec(&value)?;
    let length = bytes.len() + data.len() + 4;
    ensure!(length <= MAX_PACKET, "回复过大");
    timeout(Duration::from_secs(10), async {
        io.write_all(&(length as u32).to_be_bytes()).await?;
        io.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
        io.write_all(&bytes).await?;
        for block in data.chunks(16 * 1024) {
            io.write_all(block).await?;
        }
        io.flush().await
    })
    .await??;
    Ok(())
}
