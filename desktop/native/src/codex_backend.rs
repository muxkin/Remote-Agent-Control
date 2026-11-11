use crate::{
    codex_live::{Action, Outcome, View},
    codex_service::{Availability, Options},
    conversations::Change,
    history_media::Source,
    migration::GatewayEnvironment,
    plugin_catalog::Catalog,
    plugin_host::Host,
    plugins::Adapter,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{OwnedRwLockReadGuard, watch},
    time::{sleep, timeout},
};
use uuid::Uuid;

pub(crate) const ID: &str = "codex-local";
pub(crate) const PACKAGE: &str = "@agent-remote/adapter-codex";
const READ: Duration = Duration::from_secs(12);

#[derive(Clone, Default)]
pub struct Backend {
    inner: Option<Arc<Hosted>>,
    name: Option<Arc<str>>,
}

#[derive(Clone)]
pub struct Group(Arc<BTreeMap<String, Backend>>);

impl Default for Group {
    fn default() -> Self {
        Self(Arc::new(BTreeMap::from([(
            ID.to_owned(),
            Backend::default(),
        )])))
    }
}

impl Group {
    pub(crate) fn load(
        directory: &Path,
        runtime: &tokio::runtime::Handle,
        selections: BTreeMap<String, Selection>,
        bundled: bool,
    ) -> Result<Self> {
        let backends = selections
            .into_iter()
            .map(|(id, selection)| {
                let backend = Backend::load(directory, runtime, &id, selection, bundled)?;
                Ok((id, backend))
            })
            .collect::<Result<_>>()?;
        Ok(Self(Arc::new(backends)))
    }

    pub(crate) fn get(&self, id: &str) -> Option<&Backend> {
        self.0.get(id)
    }

    pub(crate) fn main(&self) -> &Backend {
        self.0.get(ID).expect("default Codex instance")
    }

    pub(crate) fn all(&self) -> impl Iterator<Item = (&str, &Backend)> {
        std::iter::once((ID, self.main())).chain(
            self.0
                .iter()
                .filter(|(id, _)| *id != ID)
                .map(|(id, backend)| (id.as_str(), backend)),
        )
    }

    pub(crate) fn has_history(&self) -> bool {
        self.0.values().any(Backend::has_history)
    }

    pub(crate) fn configured(&self) -> bool {
        self.0.values().any(Backend::configured)
    }

    pub(crate) async fn refresh(&self) {
        futures::future::join_all(self.0.values().map(Backend::refresh)).await;
    }
}

pub(crate) struct Selection {
    name: String,
    version: Option<String>,
    options: Options,
    read_only: bool,
}

impl Selection {
    pub(crate) fn resolve(
        id: &str,
        name: String,
        version: Option<String>,
        config: &Map<String, Value>,
        legacy: &GatewayEnvironment,
        read_only: bool,
    ) -> Result<Self> {
        let variable = |key: &str| {
            if id != ID {
                return None;
            }
            env::var_os(key)
                .or_else(|| legacy.get(key).map(Into::into))
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let configured = |key: &str| {
            config
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let absolute = |path: Option<PathBuf>| {
            path.map(|path| {
                if path.is_absolute() {
                    Ok(path)
                } else {
                    std::path::absolute(legacy.resolve(path))
                }
            })
            .transpose()
        };
        let explicit_home = variable("POCKET_NATIVE_CODEX_HOME").or_else(|| configured("home"));
        let explicit = explicit_home.is_some();
        let home = explicit_home
            .or_else(|| variable("CODEX_HOME"))
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
        Ok(Self {
            name,
            version,
            read_only,
            options: Options {
                home: absolute(home)?,
                root: absolute(configured("root").or_else(|| variable("POCKET_CODEX_ROOT")))?,
                socket: absolute(
                    variable("POCKET_NATIVE_CODEX_SOCKET")
                        .or_else(|| configured("socket"))
                        .or_else(|| variable("POCKET_CODEX_SOCKET")),
                )?,
                executable: absolute(
                    variable("POCKET_NATIVE_CODEX_EXECUTABLE")
                        .or_else(|| configured("executable"))
                        .or_else(|| variable("POCKET_CODEX_EXECUTABLE")),
                )?,
                app_tools: absolute(
                    variable("POCKET_NATIVE_CODEX_APP_TOOLS")
                        .or_else(|| configured("appTools"))
                        .or_else(|| variable("POCKET_CODEX_APP_TOOLS")),
                )?,
                cli: absolute(variable("POCKET_NATIVE_CODEX_CLI").or_else(|| configured("cli")))?,
                explicit,
            },
        })
    }
}

struct Hosted {
    host: Arc<Host>,
    available: Mutex<Availability>,
    version: Mutex<Option<String>>,
    watches: Mutex<HashMap<Uuid, Weak<RemoteWatch>>>,
}

#[derive(Clone)]
pub(crate) struct Live(Arc<RemoteWatch>);

struct RemoteWatch {
    id: Uuid,
    updates: watch::Receiver<Option<Arc<View>>>,
}

impl Live {
    pub(crate) fn view(&self) -> Option<Arc<View>> {
        self.0.updates.borrow().clone()
    }

    fn watch_id(&self) -> Uuid {
        self.0.id
    }
}

impl Backend {
    fn load(
        directory: &Path,
        runtime: &tokio::runtime::Handle,
        id: &str,
        selection: Selection,
        bundled: bool,
    ) -> Result<Self> {
        let Selection {
            name,
            version,
            options,
            read_only,
        } = selection;
        let package =
            Catalog::open(directory)?.bind_official(id, PACKAGE, version.as_deref(), bundled)?;
        let Some(package) = package else {
            return Ok(Self {
                inner: None,
                name: (id != ID).then(|| name.into()),
            });
        };
        ensure!(
            package.manifest.product == "codex",
            "官方 Codex 插件产品标识无效"
        );
        let availability = Availability {
            history: options.home.as_ref().is_some_and(|path| path.is_dir()),
            ..Availability::default()
        };
        let version = package.manifest.version.clone();
        let host = Arc::new(Host::new(
            id.into(),
            name.clone(),
            Some(package),
            serde_json::to_value(&options)?,
            directory.join("native-plugins").join("instances").join(id),
            read_only,
        ));
        runtime.spawn(host.clone().supervise(directory.to_owned()));
        Ok(Self {
            inner: Some(Arc::new(Hosted {
                host,
                available: Mutex::new(availability),
                version: Mutex::new(Some(version)),
                watches: Mutex::new(HashMap::new()),
            })),
            name: Some(name.into()),
        })
    }

    fn available(&self) -> Availability {
        match &self.inner {
            Some(remote) => *remote
                .available
                .lock()
                .expect("Codex availability mutex poisoned"),
            None => Availability::default(),
        }
    }

    pub(crate) fn has_history(&self) -> bool {
        self.available().history
    }
    pub(crate) fn has_desktop(&self) -> bool {
        self.available().desktop
    }
    pub(crate) fn configured(&self) -> bool {
        self.inner.is_some()
    }

    pub(crate) async fn refresh(&self) {
        match &self.inner {
            Some(remote) => {
                if let Ok(value) = remote
                    .host
                    .call("codex/refresh", json!({}), Duration::from_secs(8))
                    .await
                    && let Ok(available) =
                        serde_json::from_value::<Availability>(value["availability"].clone())
                {
                    *remote
                        .available
                        .lock()
                        .expect("Codex availability mutex poisoned") = available;
                    *remote.version.lock().expect("Codex package mutex poisoned") =
                        value["adapterVersion"].as_str().map(str::to_owned);
                }
            }
            None => {}
        }
    }

    pub fn status(&self, online: bool) -> Value {
        let mut result = status(self.available(), online);
        if self.inner.is_none() {
            result["reason"] = json!("尚未安装 Codex 插件");
        }
        result
    }

    pub(crate) fn info(&self, id: &str, online: bool) -> Option<Value> {
        let available = self.available();
        let mut info = match info(available, online) {
            Some(info) => info,
            None if id != ID => json!({
                "product":"codex","connected":false,"version":null,
                "profile":"rust-native-plugin","capabilities":{},
            }),
            None => return None,
        };
        info["id"] = json!(id);
        if let Some(name) = &self.name {
            info["name"] = json!(name.as_ref());
        }
        if let Some(remote) = &self.inner {
            info["profile"] = json!("rust-native-plugin");
            info["adapterVersion"] =
                json!(*remote.version.lock().expect("Codex package mutex poisoned"));
        }
        Some(info)
    }

    pub(crate) fn watch(&self, thread: Uuid) -> Option<Live> {
        match &self.inner {
            Some(remote) if self.has_desktop() => {
                let mut watches = remote
                    .watches
                    .lock()
                    .expect("Codex subscriptions mutex poisoned");
                watches.retain(|_, live| live.strong_count() > 0);
                if let Some(watch) = watches.get(&thread).and_then(Weak::upgrade) {
                    return Some(Live(watch));
                }
                if watches.len() >= 24 {
                    return None;
                }
                let (publish, updates) = watch::channel(None);
                let id = Uuid::new_v4();
                let live = Arc::new(RemoteWatch { id, updates });
                watches.insert(thread, Arc::downgrade(&live));
                let host = remote.host.clone();
                tokio::spawn(async move {
                    follow(host, thread, id, publish).await;
                });
                Some(Live(live))
            }
            _ => None,
        }
    }

    pub(crate) fn admit_write(&self) -> Result<Option<OwnedRwLockReadGuard<()>>> {
        match &self.inner {
            Some(remote) => remote.host.admit_write(),
            _ => Ok(None),
        }
    }

    pub(crate) async fn read(
        &self,
        method: &str,
        params: &Value,
        query: &Value,
        live: Option<&Live>,
    ) -> Result<Option<Value>> {
        match &self.inner {
            Some(remote) => {
                let value = remote.host.call("codex/read", json!({
                    "method":method,"params":params,"query":query,"watchId":live.map(Live::watch_id),
                }), READ).await?;
                Ok((!value.is_null()).then_some(value))
            }
            None if method == "usage.read" => {
                Ok(Some(crate::usage::unavailable("本机桌面用量暂不可用")))
            }
            None => Ok(None),
        }
    }

    pub(crate) async fn select_tools(
        &self,
        thread: Uuid,
        live: Option<&Live>,
        skills: &[String],
        plugins: &[String],
    ) -> Result<Vec<Value>> {
        let remote = self.inner.as_ref().context("尚未安装 Codex 插件")?;
        let value = remote.host.call("codex/selectTools", json!({
                    "thread":thread,"watchId":live.map(Live::watch_id),"skills":skills,"plugins":plugins,
                }), READ).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub(crate) async fn media(
        &self,
        thread: Uuid,
        device: String,
        reference: String,
        live: Option<&Live>,
    ) -> Result<Source> {
        let remote = self.inner.as_ref().context("尚未安装 Codex 插件")?;
        let value = remote.host.call("codex/media", json!({
                    "thread":thread,"device":device,"reference":reference,"watchId":live.map(Live::watch_id),
                }), Duration::from_secs(25)).await?;
        remote.host.source(value).await
    }

    pub(crate) async fn execute(
        &self,
        thread: Uuid,
        live: &Live,
        request: Uuid,
        action: Action,
    ) -> Outcome {
        match &self.inner {
            Some(remote) => remote
                .outcome(
                    "codex/execute",
                    request,
                    json!({
                        "thread":thread,"watchId":live.watch_id(),"request":request,"action":action,
                    }),
                    Duration::from_secs(40),
                )
                .await,
            None => Outcome::Rejected("尚未连接 Codex".into()),
        }
    }

    pub(crate) async fn manage(
        &self,
        thread: String,
        live: Option<&Live>,
        request: Uuid,
        change: Change,
    ) -> Outcome {
        match &self.inner {
            Some(remote) => remote.outcome("codex/manage", request, json!({
                "thread":thread,"watchId":live.map(Live::watch_id),"request":request,"change":change,
            }), Duration::from_secs(75)).await,
            None => Outcome::Rejected("尚未连接 Codex".into()),
        }
    }
}

impl Hosted {
    async fn outcome(
        &self,
        method: &'static str,
        id: Uuid,
        params: Value,
        limit: Duration,
    ) -> Outcome {
        let wait = async {
            self.host
                .call(method, params, Duration::from_secs(5))
                .await?;
            loop {
                let result = self
                    .host
                    .call(
                        "codex/result",
                        json!({"request":id}),
                        Duration::from_secs(5),
                    )
                    .await?;
                if !result.is_null() {
                    return Ok::<_, anyhow::Error>(serde_json::from_value(result)?);
                }
                sleep(Duration::from_millis(90)).await;
            }
        };
        // A lost command acknowledgement or result is inconclusive. The gateway never reissues it.
        timeout(limit, wait)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(Outcome::Uncertain)
    }
}

async fn follow(
    host: Arc<Host>,
    thread: Uuid,
    id: Uuid,
    publish: watch::Sender<Option<Arc<View>>>,
) {
    let mut epochs = host.epochs();
    let mut known = None;
    while !publish.is_closed() {
        let epoch = *epochs.borrow_and_update();
        let reply = host
            .call(
                "codex/view",
                json!({"thread":thread,"watchId":id,"known":known}),
                Duration::from_secs(6),
            )
            .await;
        let current = reply.ok().filter(|_| *epochs.borrow() == epoch);
        if !current
            .as_ref()
            .is_some_and(|value| value["unchanged"] == true)
        {
            let view = current
                .and_then(|value| serde_json::from_value::<View>(value).ok())
                .filter(|view| view.thread["id"] == thread.to_string());
            if view.is_some() || known.is_some() {
                known = view.as_ref().map(View::mark);
                publish.send_replace(view.map(Arc::new));
            }
        }
        tokio::select! {
            _ = publish.closed() => break,
            _ = epochs.changed() => {
                publish.send_replace(None);
                known = None;
            }
            _ = sleep(Duration::from_millis(160)) => {}
        }
    }
    let _ = host
        .call(
            "codex/unwatch",
            json!({"thread":thread,"watchId":id}),
            Duration::from_secs(4),
        )
        .await;
}

pub(crate) fn status(available: Availability, online: bool) -> Value {
    let online = online && available.desktop;
    let connected =
        online || available.open || available.create || available.rename || available.fork;
    let reason = match (connected, available.history) {
        (true, _) => None,
        (_, true) => Some("请先在本机 Codex 打开此会话。仍可查看已有历史。"),
        _ => Some("尚未配置 Codex 历史"),
    };
    json!({
        "connected":connected,"desktopVersion":null,"supportedVersion":connected,
        "writesEnabled":connected,"reason":reason,
        "capabilities":{
            "send":online,"steer":online,"interrupt":online,"modelSettings":online,
            "questions":online,"approvals":online,"permissionRequests":online,
            "openThread":available.open,"elicitationForms":online,
            "newThread":available.create,"queue":online,
            "renameThread":available.rename,"forkThread":available.fork,"forkFromTurn":available.fork_reply,
        }
    })
}

pub(crate) fn info(available: Availability, online: bool) -> Option<Value> {
    if !available.history {
        return None;
    }
    let online = online && available.desktop;
    let status = status(available, online);
    let mut capabilities = serde_json::Map::new();
    for (name, supported) in [
        ("history", true),
        ("send", online),
        ("steer", online),
        ("interrupt", online),
        ("respond", online),
        ("settings", online),
        ("queue", online),
        ("create", available.create),
        ("open", available.open),
        ("attachments", online),
        ("skills", true),
        ("plugins", true),
    ] {
        capabilities.insert(
            name.into(),
            json!({"state":if supported { "supported" } else { "unavailable" }}),
        );
    }
    Some(json!({
        "id":ID,"product":"codex","name":"Codex","connected":status["connected"],"version":null,"profile":"rust-native",
        "presentation":{"description":"Codex 桌面","creation":{"empty":true,"permission":"native","preset":false,"plan":false,"notice":"沿用 Codex 创建权限"},"plan":"settings","fileReferences":false,"exportLog":false,"nativeCommands":false},
        "capabilities":capabilities,
    }))
}
