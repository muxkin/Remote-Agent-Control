use crate::{
    desktop_authorization::AuthorizationLink,
    gateway::{Database, Phase, Snapshot},
    state::{private_directory, private_file},
    update::UpdateCommand,
    update_preferences::Preferences,
};
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use uuid::Uuid;

const ENDPOINT: &str = "management.json";
const HTML: &str = include_str!("management/index.html");
const CSS: &str = include_str!("management/style.css");
const SCRIPT: &str = include_str!("management/app.js");
const TICKET_LIFETIME: Duration = Duration::from_secs(120);

#[derive(Clone, Copy)]
pub(crate) enum Exit {
    Quit,
    Configure,
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub(crate) enum TrayEvent {
    Open,
    CheckUpdate,
    Quit,
}

pub(crate) type Connect = Box<dyn FnMut(&str, String) -> Result<Connected> + Send>;

pub(crate) struct Connected {
    pub(crate) origin: String,
    pub(crate) db: Database,
}

pub(crate) struct Startup {
    pub(crate) connected: Option<Connected>,
    pub(crate) package_origin: Option<&'static str>,
    pub(crate) error: Option<String>,
    pub(crate) connect: Connect,
}

struct Connection {
    connected: Option<Connected>,
    authorization: Option<AuthorizationLink>,
    package_origin: Option<&'static str>,
    error: Option<String>,
    connect: Connect,
}

pub(crate) struct Owner {
    _lock: File,
    endpoint: PathBuf,
}

pub(crate) fn claim(directory: &Path) -> Result<Option<Owner>> {
    private_directory(directory)?;
    let lock = private_file(&directory.join("management.lock"), true)?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(Owner {
            _lock: lock,
            endpoint: directory.join(ENDPOINT),
        })),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.endpoint);
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Instance {
    port: u16,
    secret: Uuid,
}

impl Instance {
    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn url(&self, ticket: Uuid) -> String {
        format!("{}/#{ticket}", self.origin())
    }

    async fn request_url(&self) -> Result<String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1))
            .build()?;
        let ticket: Uuid = client
            .post(format!("{}/api/launch", self.origin()))
            .bearer_auth(self.secret)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(self.url(ticket))
    }
}

pub(crate) async fn reopen(directory: &Path, print: bool) -> Result<()> {
    let endpoint = directory.join(ENDPOINT);
    for _ in 0..20 {
        let instance = private_file(&endpoint, false)
            .ok()
            .and_then(|file| serde_json::from_reader::<_, Instance>(file.take(4096)).ok());
        if let Some(instance) = instance
            && let Ok(url) = instance.request_url().await
        {
            return open_url(&url, print);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("适配器正在启动或退出，请稍后再次打开设置")
}

fn open_url(url: &str, print: bool) -> Result<()> {
    if print {
        println!("{url}");
    } else {
        open::that_detached(url).context("无法打开默认浏览器，可用 --print-settings 获取链接")?;
    }
    Ok(())
}

pub(crate) struct Manager {
    pub(crate) state: Arc<Panel>,
    pub(crate) stop: watch::Receiver<Option<Exit>>,
    // Close the listener before the instance lock and endpoint are released.
    server: tokio::task::JoinHandle<()>,
    _owner: Owner,
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub(crate) struct Panel {
    instance: Instance,
    auth: Uuid,
    tickets: Mutex<HashMap<Uuid, Instant>>,
    connection: Mutex<Connection>,
    updates: watch::Receiver<Snapshot>,
    pair: mpsc::Sender<()>,
    updater: mpsc::Sender<UpdateCommand>,
    stop: watch::Sender<Option<Exit>>,
    startup: Mutex<Option<bool>>,
}

impl Manager {
    pub(crate) fn start(
        runtime: &tokio::runtime::Runtime,
        owner: Owner,
        startup: Startup,
        updates: watch::Receiver<Snapshot>,
        pair: mpsc::Sender<()>,
        updater: mpsc::Sender<UpdateCommand>,
    ) -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let instance = Instance {
            port: listener.local_addr()?.port(),
            secret: Uuid::new_v4(),
        };
        let (stop, receive) = watch::channel(None);
        let state = Arc::new(Panel {
            instance,
            auth: Uuid::new_v4(),
            tickets: Mutex::new(HashMap::new()),
            connection: Mutex::new(Connection {
                connected: startup.connected,
                authorization: None,
                package_origin: startup.package_origin,
                error: startup.error,
                connect: startup.connect,
            }),
            updates,
            pair,
            updater,
            stop,
            startup: Mutex::new(startup_state()),
        });
        let temporary = owner
            .endpoint
            .with_extension(format!("{}.tmp", Uuid::new_v4()));
        let publish = (|| -> Result<()> {
            let file = private_file(&temporary, true)?;
            serde_json::to_writer(&file, &state.instance)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &owner.endpoint)?;
            Ok(())
        })();
        if publish.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        publish?;
        let listener = {
            let _enter = runtime.enter();
            tokio::net::TcpListener::from_std(listener)?
        };
        let server = runtime.spawn(serve(listener, state.clone()));
        Ok(Self {
            state,
            stop: receive,
            server,
            _owner: owner,
        })
    }
}

async fn serve(listener: tokio::net::TcpListener, panel: Arc<Panel>) {
    let limit = Arc::new(Semaphore::new(32));
    while let Ok((stream, _)) = listener.accept().await {
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            continue;
        };
        let panel = panel.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = service_fn(move |request| {
                let panel = panel.clone();
                async move { Ok::<_, std::convert::Infallible>(panel.respond(request).await) }
            });
            let mut http = http1::Builder::new();
            http.timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(5))
                .keep_alive(false);
            let _ = tokio::time::timeout(
                Duration::from_secs(12),
                http.serve_connection(TokioIo::new(stream), service),
            )
            .await;
        });
    }
}

type Reply = Response<Full<Bytes>>;

fn reply(code: StatusCode, kind: &'static str, bytes: impl Into<Bytes>) -> Reply {
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(Full::new(bytes.into()))
        .expect("valid local response")
}

fn json_reply(code: StatusCode, value: Value) -> Reply {
    reply(code, "application/json", value.to_string())
}

fn failure(code: StatusCode, message: impl ToString) -> Reply {
    json_reply(code, json!({ "error": message.to_string() }))
}

fn authenticated(request: &Request<Incoming>, secret: Uuid) -> bool {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .and_then(|value| Uuid::parse_str(value).ok())
        == Some(secret)
}

async fn body<T: DeserializeOwned>(request: Request<Incoming>) -> Result<T> {
    ensure!(
        request
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v == "application/json"),
        "请求格式无效"
    );
    let data = Limited::new(request.into_body(), 8192)
        .collect()
        .await
        .map_err(|_| anyhow::anyhow!("请求过大或不完整"))?;
    serde_json::from_slice(&data.to_bytes()).context("请求格式无效")
}

#[derive(Deserialize)]
struct Enrollment {
    origin: String,
    enrollment: String,
}

#[derive(Deserialize)]
struct AuthorizationRequest {
    #[serde(default)]
    origin: String,
}

#[derive(Deserialize)]
struct UpdateSettings {
    automatic: bool,
    base: String,
}

#[derive(Deserialize)]
struct StartupSettings {
    enabled: bool,
}

impl Panel {
    fn issue_ticket(&self) -> Uuid {
        let mut tickets = self.tickets.lock().expect("tickets mutex");
        let now = Instant::now();
        tickets.retain(|_, expiry| *expiry > now);
        if tickets.len() >= 32
            && let Some(oldest) = tickets
                .iter()
                .min_by_key(|(_, expiry)| *expiry)
                .map(|(id, _)| *id)
        {
            tickets.remove(&oldest);
        }
        let ticket = Uuid::new_v4();
        tickets.insert(ticket, now + TICKET_LIFETIME);
        ticket
    }

    pub(crate) fn open(&self, print: bool) -> Result<()> {
        open_url(&self.instance.url(self.issue_ticket()), print)
    }

    pub(crate) fn exit(&self, exit: Exit) {
        self.stop.send_if_modified(|pending| {
            if pending.is_some() {
                return false;
            }
            *pending = Some(exit);
            true
        });
    }

    pub(crate) fn check_update(&self) {
        let _ = self.updater.try_send(UpdateCommand::Check);
    }

    async fn respond(self: &Arc<Self>, request: Request<Incoming>) -> Reply {
        let authority = format!("127.0.0.1:{}", self.instance.port);
        if request
            .headers()
            .get(header::HOST)
            .is_none_or(|value| value != authority.as_str())
            || request.uri().authority().is_some()
        {
            return failure(StatusCode::FORBIDDEN, "本机设置地址无效");
        }
        let origin = self.instance.origin();
        let same_origin = request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|value| value == origin.as_str());
        let path = request.uri().path();
        if request.method() == Method::GET {
            match path {
                "/authorize/callback" => {
                    let url = self
                        .connection
                        .lock()
                        .expect("connection mutex")
                        .authorization
                        .as_mut()
                        .and_then(|link| link.complete(request.uri().query()?));
                    return match url {
                        Some(url) => {
                            let mut response = reply(
                                StatusCode::SEE_OTHER,
                                "text/plain; charset=utf-8",
                                Bytes::new(),
                            );
                            response.headers_mut().insert(
                                header::LOCATION,
                                url.as_str().parse().expect("valid URL header"),
                            );
                            response
                        }
                        None => {
                            failure(StatusCode::GONE, "授权链接已失效，请从适配器重新打开登录页")
                        }
                    };
                }
                "/" => return reply(StatusCode::OK, "text/html; charset=utf-8", HTML),
                "/style.css" => return reply(StatusCode::OK, "text/css; charset=utf-8", CSS),
                "/app.js" => {
                    return reply(StatusCode::OK, "text/javascript; charset=utf-8", SCRIPT);
                }
                "/favicon.ico" => {
                    return reply(StatusCode::NO_CONTENT, "image/x-icon", Bytes::new());
                }
                _ => {}
            }
        }
        if request.method() == Method::POST
            && path == "/api/launch"
            && authenticated(&request, self.instance.secret)
            && !request.headers().contains_key(header::ORIGIN)
        {
            return json_reply(StatusCode::OK, json!(self.issue_ticket()));
        }
        if request.method() == Method::POST && !same_origin {
            return failure(StatusCode::FORBIDDEN, "请从本机设置页操作");
        }
        if request.method() == Method::POST && path == "/api/session" {
            let ticket: Result<Uuid> = body(request).await;
            if ticket
                .ok()
                .and_then(|id| self.tickets.lock().expect("tickets mutex").remove(&id))
                .is_some_and(|expiry| expiry > Instant::now())
            {
                return json_reply(StatusCode::OK, json!({ "token": self.auth }));
            }
            return failure(StatusCode::UNAUTHORIZED, "链接已失效，请从托盘重新打开设置");
        }
        if !authenticated(&request, self.auth) {
            return failure(StatusCode::UNAUTHORIZED, "请从托盘重新打开设置");
        }
        let result = match (request.method(), path) {
            (&Method::GET, "/api/status") => return json_reply(StatusCode::OK, self.status()),
            (&Method::GET, "/api/pair-qr") => return self.qr(),
            (&Method::POST, "/api/connect") => self.connect(body(request).await).await,
            (&Method::POST, "/api/authorize") => self.authorize(body(request).await).await,
            (&Method::POST, "/api/pair") => {
                if self.updates.borrow().phase != Phase::Online {
                    Err(anyhow::anyhow!("连接服务后才能生成配对码"))
                } else {
                    self.pair.try_send(()).context("正在生成配对码，请稍候")
                }
            }
            (&Method::POST, "/api/update/check") => self
                .updater
                .try_send(UpdateCommand::Check)
                .context("暂时无法检查更新"),
            (&Method::POST, "/api/update/install") => self
                .updater
                .try_send(UpdateCommand::Install)
                .context("暂时无法安装更新"),
            (&Method::POST, "/api/update/settings") => {
                self.configure_updates(body(request).await).await
            }
            (&Method::POST, "/api/startup") => self.configure_startup(body(request).await).await,
            (&Method::POST, "/api/configure" | "/api/quit") => {
                let exit = if path == "/api/configure" {
                    Exit::Configure
                } else {
                    Exit::Quit
                };
                let panel = self.clone();
                tokio::spawn(async move {
                    // Give the browser time to receive the response before the server closes.
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    panel.exit(exit);
                });
                Ok(())
            }
            _ => return failure(StatusCode::NOT_FOUND, "页面不存在"),
        };
        match result {
            Ok(()) => json_reply(StatusCode::OK, json!({ "ok": true })),
            Err(error) => failure(StatusCode::BAD_REQUEST, error),
        }
    }

    fn status(&self) -> Value {
        let snapshot = self.updates.borrow().clone();
        let connection = self.connection.lock().expect("connection mutex");
        let phase = match snapshot.phase {
            Phase::Setup => {
                if connection.connected.is_some() {
                    "connecting"
                } else {
                    "setup"
                }
            }
            Phase::Connecting => "connecting",
            Phase::Online => "online",
            Phase::Unavailable => "unavailable",
        };
        let agents: Vec<_> = snapshot
            .agents
            .iter()
            .map(|agent| json!({ "name": agent.name, "connected": agent.connected }))
            .collect();
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "origin": connection.connected.as_ref().map(|state| &state.origin),
            "packageOrigin": connection.package_origin,
            "setupError": connection.error,
            "phase": phase,
            "pairing": snapshot.pairing.filter(|pair| pair.expires_at > crate::state::now())
                .map(|pair| json!({ "link": pair.link, "expiresAt": pair.expires_at })),
            "history": snapshot.history,
            "agents": agents,
            "update": snapshot.update,
            "checking": snapshot.update_checking,
            "manualUpdate": snapshot.manual_update,
            "updateSettings": snapshot.update_preferences,
            "startup": *self.startup.lock().expect("startup mutex"),
        })
    }

    fn qr(&self) -> Reply {
        let Some(pair) = self
            .updates
            .borrow()
            .pairing
            .clone()
            .filter(|pair| pair.expires_at > crate::state::now())
        else {
            return failure(StatusCode::NOT_FOUND, "配对码已失效");
        };
        match qrcode::QrCode::new(pair.link.as_bytes()) {
            Ok(qr) => reply(
                StatusCode::OK,
                "image/svg+xml",
                qr.render::<qrcode::render::svg::Color>()
                    .min_dimensions(240, 240)
                    .build(),
            ),
            Err(_) => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "无法生成二维码，可复制配对链接",
            ),
        }
    }

    async fn connect(self: &Arc<Self>, payload: Result<Enrollment>) -> Result<()> {
        let payload = payload?;
        let panel = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = panel.connection.lock().expect("connection mutex");
            ensure!(connection.connected.is_none(), "请先从设置中选择切换服务");
            let connected =
                (connection.connect)(payload.origin.trim(), payload.enrollment.trim().to_owned())?;
            connection.connected = Some(connected);
            connection.error = None;
            Ok(())
        })
        .await?
    }

    async fn authorize(self: &Arc<Self>, payload: Result<AuthorizationRequest>) -> Result<()> {
        let payload = payload?;
        let panel = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = panel.connection.lock().expect("connection mutex");
            if connection.connected.is_none() {
                let origin = payload.origin.trim();
                connection.connected = Some((connection.connect)(origin, String::new())?);
                connection.error = None;
            }
            let Connection {
                connected,
                authorization,
                ..
            } = &mut *connection;
            let connected = connected.as_ref().context("适配器尚未连接")?;
            let mut db = connected.db.lock().expect("database mutex poisoned");
            let url = AuthorizationLink::open(
                authorization,
                &mut db,
                &connected.origin,
                panel.instance.port,
            )?;
            drop(db);
            open_url(&url, false)
        })
        .await?
    }

    async fn configure_startup(&self, settings: Result<StartupSettings>) -> Result<()> {
        let enabled = settings?.enabled;
        set_startup(enabled).await?;
        *self.startup.lock().expect("startup mutex") = Some(enabled);
        Ok(())
    }

    async fn configure_updates(&self, settings: Result<UpdateSettings>) -> Result<()> {
        let settings = settings?;
        let preferences = Preferences::new(settings.automatic, &settings.base)?;
        let (send, receive) = oneshot::channel();
        self.updater
            .try_send(UpdateCommand::Configure(preferences, send))
            .context("暂时无法保存更新设置")?;
        tokio::time::timeout(Duration::from_secs(8), receive).await??
    }
}

fn startup_state() -> Option<bool> {
    #[cfg(feature = "desktop")]
    {
        crate::desktop_shell::startup().ok()?.is_enabled().ok()
    }
    #[cfg(not(feature = "desktop"))]
    None
}

async fn set_startup(enabled: bool) -> Result<()> {
    #[cfg(feature = "desktop")]
    {
        tokio::task::spawn_blocking(move || {
            let startup = crate::desktop_shell::startup()?;
            if enabled {
                startup.enable()?;
            } else {
                startup.disable()?;
            }
            Ok(())
        })
        .await?
    }
    #[cfg(not(feature = "desktop"))]
    {
        let _ = enabled;
        anyhow::bail!("当前构建不提供登录自启动")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::DisplayPairing;

    #[test]
    fn settings_ticket_is_local_one_time_and_protects_commands() -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("state");
        let owner = claim(&directory)?.context("claim instance")?;
        assert!(claim(&directory)?.is_none());
        let (_, updates) = watch::channel(Snapshot {
            phase: Phase::Online,
            pairing: Some(DisplayPairing {
                link: "https://example.test/#pair=sample".into(),
                expires_at: crate::state::now() + 30_000,
            }),
            ..Default::default()
        });
        let (pair, mut pairs) = mpsc::channel(1);
        let (updater, _commands) = mpsc::channel(1);
        let manager = Manager::start(
            &runtime,
            owner,
            Startup {
                connected: None,
                package_origin: Some("https://package.example.test"),
                error: None,
                connect: Box::new(|_, _| unreachable!()),
            },
            updates,
            pair,
            updater,
        )?;
        runtime.block_on(async {
            let client = reqwest::Client::builder().no_proxy().build()?;
            let instance = &manager.state.instance;
            let origin = instance.origin();
            let status = format!("{origin}/api/status");
            let ticket = instance.request_url().await?;
            let (_, ticket) = ticket.split_once('#').context("missing ticket")?;
            let authenticate = |site: &str| {
                client
                    .post(format!("{origin}/api/session"))
                    .header(header::ORIGIN, site)
                    .json(ticket)
                    .send()
            };
            assert_eq!(
                client.get(&status).send().await?.status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                authenticate("https://example.test").await?.status(),
                StatusCode::FORBIDDEN
            );
            let session: Value = authenticate(&origin)
                .await?
                .error_for_status()?
                .json()
                .await?;
            assert_eq!(
                authenticate(&origin).await?.status(),
                StatusCode::UNAUTHORIZED
            );
            let token = session["token"].as_str().context("missing token")?;
            let state: Value = client
                .get(&status)
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            assert!(state["origin"].is_null());
            assert_eq!(state["packageOrigin"], "https://package.example.test");
            assert_eq!(
                client
                    .get(&status)
                    .header(header::HOST, "example.test")
                    .bearer_auth(token)
                    .send()
                    .await?
                    .status(),
                StatusCode::FORBIDDEN
            );
            let qr = client
                .get(format!("{origin}/api/pair-qr"))
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?;
            assert_eq!(qr.headers()[header::CONTENT_TYPE], "image/svg+xml");
            assert!(qr.text().await?.contains("<svg"));
            let pair = client.post(format!("{origin}/api/pair")).bearer_auth(token);
            assert_eq!(
                pair.try_clone().unwrap().send().await?.status(),
                StatusCode::FORBIDDEN
            );
            assert!(pairs.try_recv().is_err());
            pair.header(header::ORIGIN, &origin)
                .send()
                .await?
                .error_for_status()?;
            assert!(pairs.try_recv().is_ok());
            Ok::<_, anyhow::Error>(())
        })?;
        drop(manager);
        assert!(!directory.join(ENDPOINT).exists());
        assert!(claim(&directory)?.is_some());
        Ok(())
    }
}
