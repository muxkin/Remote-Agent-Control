use crate::{dsh::Dsh, files::VerifiedUpload, history_media::Source, state::private_file};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::watch;
use uuid::Uuid;

#[async_trait]
pub(crate) trait Adapter: Send + Sync {
    fn id(&self) -> &str;
    fn admit_write(&self) -> Result<Option<tokio::sync::OwnedRwLockReadGuard<()>>> {
        Ok(None)
    }
    fn validate_selection(&self, _skills: &[String], _plugins: &[String]) -> Result<()> {
        Ok(())
    }
    fn uploads_enabled(&self) -> bool;
    async fn info(&self) -> Value;
    async fn status(&self) -> Value;
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>>;
    async fn media(&self, thread: &str, reference: &str) -> Result<Media>;
    async fn export_log(&self, thread: &str) -> Result<Source>;
    fn subscribe(self: Arc<Self>, thread: &str) -> Result<Arc<Subscription>>;
    async fn write(
        &self,
        thread: &str,
        request: Uuid,
        action: Write,
        live: Option<Arc<Subscription>>,
        created: &RecordCreated<'_>,
    ) -> Delivery;
}

pub(crate) enum Media {
    Download(Source),
    VerifiedFile {
        name: String,
        size: u64,
        attachment_id: String,
        sha256: String,
    },
}

pub(crate) type RecordCreated<'a> =
    dyn for<'thread> Fn(&'thread str) -> Result<()> + Send + Sync + 'a;

pub(crate) struct Subscription(pub watch::Receiver<Option<Arc<View>>>);

#[derive(Clone)]
pub(crate) struct View {
    pub thread: Value,
    pub messages: Arc<[Value]>,
    pub streamed: Option<Value>,
    pub observations: Arc<[Observation]>,
    pub image_limits: Value,
    pub continued_questions: Value,
    pub plugin_epoch: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct Observation {
    pub request: Option<Uuid>,
    pub turn: String,
    pub state: &'static str,
}

#[derive(Clone, Serialize)]
pub(crate) enum Write {
    Send {
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        files: Vec<VerifiedUpload>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        skills: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        plugin_ids: Vec<String>,
    },
    Steer {
        expected: String,
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        files: Vec<VerifiedUpload>,
    },
    Interrupt {
        expected: String,
    },
    Queue {
        expected: String,
        text: String,
    },
    RemoveQueued {
        expected: String,
        message: String,
    },
    Rename {
        title: String,
    },
    Create {
        title: Option<String>,
        prompt: String,
        project: Option<String>,
        #[serde(skip_serializing_if = "CreationSettings::is_empty")]
        settings: CreationSettings,
    },
    Settings(ModelSettings),
    Control(Control),
    Respond(crate::requests::Response),
    Open,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct CreationSettings {
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub permission: Option<String>,
    pub preset: Option<String>,
    pub plan: Option<bool>,
}

impl CreationSettings {
    pub(crate) fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.thinking.is_none()
            && self.permission.is_none()
            && self.preset.is_none()
            && self.plan.is_none()
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSettings {
    pub model: String,
    pub effort: String,
    pub mode: Option<Mode>,
    pub service_tier: Option<String>,
    pub expected_service_tier: Option<String>,
    pub expected_mode: Option<Mode>,
    pub expected_model: Option<String>,
    pub expected_effort: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    Default,
    Plan,
}

impl Mode {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Plan => "plan",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Control {
    Permission {
        value: String,
        expected: Option<String>,
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<String>,
    },
    Preset {
        value: String,
    },
    Plan {
        enabled: bool,
    },
    Compact,
    Feedback {
        text: String,
    },
    Goal {
        operation: GoalOperation,
        #[serde(rename = "ref")]
        reference: Option<GoalRef>,
        objective: Option<String>,
    },
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GoalOperation {
    Create,
    Edit,
    Pause,
    Resume,
    Complete,
    Clear,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GoalRef {
    pub id: String,
    pub revision: u64,
}

impl Write {
    pub(crate) fn dispatch_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            Self::Send { files, .. } | Self::Steer { files, .. } if !files.is_empty() => 180,
            _ => 45,
        })
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Send { .. } => "send",
            Self::Steer { .. } => "steer",
            Self::Interrupt { .. } => "interrupt",
            Self::Queue { .. } => "queue",
            Self::RemoveQueued { .. } => "queue-remove",
            Self::Rename { .. } => "rename",
            Self::Create { .. } => "create",
            Self::Settings(_) => "settings",
            Self::Control(_) => "control",
            Self::Respond(_) => "respond",
            Self::Open => "open",
        }
    }
}

pub(crate) enum Delivery {
    Accepted(Option<String>),
    Completed(Option<String>),
    Command { id: String, succeeded: bool },
    Rejected(&'static str),
    Uncertain,
}

#[derive(Clone, Default)]
pub(crate) struct Registry(Arc<HashMap<String, Arc<dyn Adapter>>>);

#[derive(Deserialize)]
struct Instance {
    id: String,
    name: String,
    plugin: String,
    version: Option<String>,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    secrets: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ConfigRow {
    Package(Instance),
    Legacy {
        #[serde(rename = "type")]
        kind: String,
        id: String,
        name: String,
        url: String,
        #[serde(rename = "tokenEnv")]
        token_env: String,
        version: String,
    },
}

impl ConfigRow {
    fn into_instance(self) -> Option<Instance> {
        match self {
            Self::Package(instance) => Some(instance),
            Self::Legacy {
                kind,
                id,
                name,
                url,
                token_env,
                version,
            } if kind == "dsh" => Some(Instance {
                id,
                name,
                plugin: "@agent-remote/adapter-dsh".to_owned(),
                version: None,
                config: json!({"url":url,"version":version}),
                secrets: HashMap::from([("token".to_owned(), token_env)]),
            }),
            Self::Legacy { .. } => None,
        }
    }
}

impl Registry {
    pub(crate) fn load(directory: &Path, runtime: &tokio::runtime::Handle) -> Result<Self> {
        let legacy = env::var_os("POCKET_NATIVE_LEGACY_STATE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path != directory);
        let mut secrets = HashMap::new();
        for root in legacy
            .iter()
            .map(PathBuf::as_path)
            .chain(std::iter::once(directory))
        {
            let path = root.join("gateway.env");
            if path.exists() {
                for entry in dotenvy::Iter::new(private_file(&path, false)?) {
                    let (name, value) = entry.map_err(|_| anyhow::anyhow!("插件凭据配置无效"))?;
                    secrets.insert(name, value);
                }
            }
        }
        let path = |key: &str| {
            env::var_os(key)
                .map(PathBuf::from)
                .or_else(|| secrets.get(key).map(PathBuf::from))
                .filter(|path| !path.as_os_str().is_empty())
        };
        let local = directory.join("instances.json");
        let file = path("POCKET_ADAPTERS_FILE")
            .or_else(|| path("POCKET_BACKENDS_FILE"))
            .or_else(|| local.exists().then_some(local))
            .or_else(|| {
                legacy
                    .as_ref()
                    .map(|root| root.join("instances.json"))
                    .filter(|file| file.exists())
            })
            .or_else(|| path("POCKET_NATIVE_DEFAULT_INSTANCES"));
        let Some(file) = file else {
            return Ok(Self::default());
        };
        let mut bytes = Vec::new();
        private_file(&file, false)?
            .take(128 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 128 * 1024, "插件实例配置过大");
        let rows: Vec<ConfigRow> = serde_json::from_slice(&bytes).context("插件实例配置无效")?;
        ensure!(rows.len() <= 33, "插件实例配置过多");
        let read_only = ["POCKET_NATIVE_READ_ONLY", "POCKET_READ_ONLY"]
            .iter()
            .any(|key| {
                env::var(key).as_deref() == Ok("1")
                    || secrets.get(*key).is_some_and(|value| value == "1")
            });
        let mut plugins = HashMap::<String, Arc<dyn Adapter>>::new();
        let mut hosts = Vec::new();
        for row in rows.into_iter().filter_map(ConfigRow::into_instance) {
            if row.id == "codex-local" && row.plugin == "@agent-remote/adapter-codex" {
                continue;
            }
            ensure!(
                (1..=80).contains(&row.id.len())
                    && row.id != "codex-local"
                    && row
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                    && (1..=160).contains(&row.name.len()),
                "插件实例标识无效"
            );
            if row.plugin != "@agent-remote/adapter-dsh" {
                let package = crate::plugin_catalog::Catalog::open(directory)
                    .and_then(|catalog| catalog.bind(&row.id, &row.plugin, row.version.as_deref()))
                    .ok()
                    .flatten();
                let mut config = row.config.as_object().cloned().unwrap_or_default();
                for (key, variable) in row.secrets {
                    ensure!(
                        !variable.is_empty()
                            && variable
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
                        "插件凭据变量无效"
                    );
                    let value = env::var(&variable)
                        .ok()
                        .or_else(|| secrets.get(&variable).cloned())
                        .unwrap_or_default();
                    config.insert(key, json!(value));
                }
                let private = directory
                    .join("native-plugins")
                    .join("instances")
                    .join(&row.id);
                let instance_read_only = read_only || config.get("readOnly") == Some(&json!(true));
                let id = row.id;
                let host = Arc::new(crate::plugin_host::Host::new(
                    id.clone(),
                    row.name,
                    package,
                    Value::Object(config),
                    private,
                    instance_read_only,
                ));
                ensure!(
                    plugins.insert(id, host.clone()).is_none(),
                    "插件实例标识重复"
                );
                hosts.push(host);
                continue;
            }
            let token = if let Some(variable) = row.secrets.get("token") {
                ensure!(
                    !variable.is_empty()
                        && variable
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
                    "DSH 凭据变量无效"
                );
                env::var(variable)
                    .ok()
                    .or_else(|| secrets.get(variable).cloned())
                    .unwrap_or_default()
            } else {
                row.config["token"].as_str().unwrap_or_default().to_owned()
            };
            let dsh = Dsh::new(
                row.id,
                row.name,
                row.config["url"].as_str().context("DSH 缺少服务地址")?,
                row.config["version"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
                token,
                read_only || row.config["readOnly"] == true,
            )?;
            let id = dsh.id().to_owned();
            ensure!(
                plugins.insert(id, Arc::new(dsh)).is_none(),
                "DSH 实例标识重复"
            );
        }
        for host in hosts {
            runtime.spawn(host.supervise(directory.to_owned()));
        }
        Ok(Self(Arc::new(plugins)))
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<dyn Adapter>> {
        self.0.get(id).cloned()
    }

    pub(crate) async fn infos(&self) -> Vec<Value> {
        let mut plugins: Vec<_> = self.0.values().collect();
        plugins.sort_unstable_by_key(|plugin| plugin.id());
        futures::future::join_all(plugins.into_iter().map(|plugin| plugin.info())).await
    }
}
