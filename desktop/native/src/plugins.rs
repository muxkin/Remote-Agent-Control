use crate::{
    codex_backend::{self, Selection},
    files::VerifiedUpload,
    history_media::Source,
    migration::GatewayEnvironment,
    state::private_file,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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
    #[cfg(feature = "official-plugins")]
    pub image_limits: Value,
    #[cfg(feature = "official-plugins")]
    pub continued_questions: Value,
    pub plugin_epoch: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct Observation {
    pub request: Option<Uuid>,
    pub turn: String,
    pub state: &'static str,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) enum Write {
    Send {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<VerifiedUpload>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        skills: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        plugin_ids: Vec<String>,
    },
    Steer {
        expected: String,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
        #[serde(default, skip_serializing_if = "CreationSettings::is_empty")]
        settings: CreationSettings,
    },
    Settings(ModelSettings),
    Control(Control),
    Respond(crate::requests::Response),
    Open,
}

#[derive(Clone, Default, Serialize, Deserialize)]
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

#[cfg(feature = "official-plugins")]
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

fn instance_configuration(
    directory: &Path,
    environment: &GatewayEnvironment,
) -> Result<Vec<Instance>> {
    let path = |key: &str| {
        env::var_os(key)
            .map(PathBuf::from)
            .or_else(|| environment.get(key).map(PathBuf::from))
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| environment.resolve(path))
    };
    let local = directory.join("instances.json");
    let file = path("POCKET_ADAPTERS_FILE")
        .or_else(|| path("POCKET_BACKENDS_FILE"))
        .or_else(|| local.exists().then_some(local))
        .or_else(|| {
            crate::migration::source()
                .map(|root| root.join("instances.json"))
                .filter(|file| file.exists())
        })
        .or_else(|| path("POCKET_NATIVE_DEFAULT_INSTANCES"));
    let rows: Vec<ConfigRow> = if let Some(file) = file {
        let mut bytes = Vec::new();
        private_file(&file, false)?
            .take(128 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 128 * 1024, "插件实例配置过大");
        serde_json::from_slice(&bytes).context("插件实例配置无效")?
    } else {
        Vec::new()
    };
    ensure!(rows.len() <= 33, "插件实例配置过多");
    let rows: Vec<_> = rows
        .into_iter()
        .filter_map(ConfigRow::into_instance)
        .collect();
    let mut seen = HashSet::new();
    for row in &rows {
        ensure!(
            valid_instance_id(&row.id) && (1..=160).contains(&row.name.len()),
            "插件实例标识无效"
        );
        let directory_key = if cfg!(any(windows, target_os = "macos")) {
            row.id.to_ascii_lowercase()
        } else {
            row.id.clone()
        };
        ensure!(
            directory_key != codex_backend::ID
                || (row.id == codex_backend::ID && row.plugin == codex_backend::PACKAGE),
            "默认 Codex 实例只能使用官方 Codex 插件"
        );
        ensure!(seen.insert(directory_key), "插件实例标识重复");
    }
    Ok(rows)
}

pub(crate) fn instance_names(directory: &Path) -> Result<BTreeMap<String, String>> {
    let environment = GatewayEnvironment::load(directory, crate::migration::source())?;
    let rows = instance_configuration(directory, &environment)?;
    let mut names = BTreeMap::from([(codex_backend::ID.to_owned(), "Codex".to_owned())]);
    names.extend(rows.into_iter().map(|row| (row.id, row.name)));
    Ok(names)
}

impl Registry {
    pub(crate) fn load(
        directory: &Path,
        runtime: &tokio::runtime::Handle,
        bundled: bool,
        environment: &GatewayEnvironment,
    ) -> Result<(Self, BTreeMap<String, Selection>)> {
        let rows = instance_configuration(directory, environment)?;
        let read_only = ["POCKET_NATIVE_READ_ONLY", "POCKET_READ_ONLY"]
            .iter()
            .any(|key| env::var(key).as_deref() == Ok("1") || environment.get(key) == Some("1"));
        let mut plugins = HashMap::<String, Arc<dyn Adapter>>::new();
        let mut hosts = Vec::new();
        let mut codex = BTreeMap::new();
        for row in rows {
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
                    .or_else(|| environment.get(&variable).map(str::to_owned))
                    .unwrap_or_default();
                config.insert(key, json!(value));
            }
            let instance_read_only = read_only || config.get("readOnly") == Some(&json!(true));
            if row.plugin == codex_backend::PACKAGE {
                let selection = Selection::resolve(
                    &row.id,
                    row.name,
                    row.version,
                    &config,
                    environment,
                    instance_read_only,
                )?;
                codex.insert(row.id, selection);
                continue;
            }
            let is_dsh = row.plugin == "@agent-remote/adapter-dsh";
            let package = crate::plugin_catalog::Catalog::open(directory)
                .and_then(|catalog| {
                    if is_dsh {
                        catalog.bind_official(&row.id, &row.plugin, row.version.as_deref(), bundled)
                    } else {
                        catalog.bind(&row.id, &row.plugin, row.version.as_deref())
                    }
                })
                .ok()
                .flatten();
            ensure!(
                !is_dsh
                    || package
                        .as_ref()
                        .is_none_or(|package| package.manifest.product == "dsh"),
                "官方 DSH 插件产品标识无效"
            );
            let private = directory
                .join("native-plugins")
                .join("instances")
                .join(&row.id);
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
        }
        for host in hosts {
            runtime.spawn(host.supervise(directory.to_owned()));
        }
        if !codex.contains_key(codex_backend::ID) {
            let selection = Selection::resolve(
                codex_backend::ID,
                "Codex".into(),
                None,
                &Default::default(),
                environment,
                read_only,
            )?;
            codex.insert(codex_backend::ID.into(), selection);
        }
        Ok((Self(Arc::new(plugins)), codex))
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

pub(crate) fn valid_instance_id(id: &str) -> bool {
    (1..=80).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
