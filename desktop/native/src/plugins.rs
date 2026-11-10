use crate::{dsh::Dsh, files::VerifiedUpload, history_media::Source, state::private_file};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, env, io::Read, path::Path, sync::Arc};
use tokio::sync::watch;
use uuid::Uuid;

#[async_trait]
pub(crate) trait Adapter: Send + Sync {
    fn id(&self) -> &str;
    fn uploads_enabled(&self) -> bool;
    async fn info(&self) -> Value;
    async fn status(&self) -> Value;
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>>;
    async fn media(&self, thread: &str, reference: &str) -> Result<Media>;
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
        }
    }
}

pub(crate) enum Delivery {
    Accepted(Option<String>),
    Completed(Option<String>),
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
    #[serde(default)]
    config: Value,
    #[serde(default)]
    secrets: HashMap<String, String>,
}

impl Registry {
    pub(crate) fn load(directory: &Path) -> Result<Self> {
        let configured = env::var_os("POCKET_ADAPTERS_FILE");
        let file = configured
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| directory.join("instances.json"));
        if configured.is_none() && !file.exists() {
            return Ok(Self::default());
        }
        let mut bytes = Vec::new();
        private_file(&file, false)?
            .take(128 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 128 * 1024, "插件实例配置过大");
        let rows: Vec<Instance> = serde_json::from_slice(&bytes).context("插件实例配置无效")?;
        ensure!(rows.len() <= 16, "插件实例配置过多");
        let private_env = directory.join("gateway.env");
        let mut secrets = HashMap::new();
        if private_env.exists() {
            for entry in dotenvy::Iter::new(private_file(&private_env, false)?) {
                let (name, value) = entry.map_err(|_| anyhow::anyhow!("插件凭据配置无效"))?;
                secrets.insert(name, value);
            }
        }
        let read_only = ["POCKET_NATIVE_READ_ONLY", "POCKET_READ_ONLY"]
            .iter()
            .any(|key| {
                env::var(key).as_deref() == Ok("1")
                    || secrets.get(*key).is_some_and(|value| value == "1")
            });
        let mut plugins = HashMap::<String, Arc<dyn Adapter>>::new();
        for row in rows {
            if row.plugin != "@agent-remote/adapter-dsh" {
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
                "DSH 实例标识无效"
            );
            let variable = row.secrets.get("token").context("DSH 缺少凭据变量")?;
            ensure!(
                variable
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
                "DSH 凭据变量无效"
            );
            let token = env::var(variable)
                .ok()
                .or_else(|| secrets.get(variable).cloned())
                .unwrap_or_default();
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
