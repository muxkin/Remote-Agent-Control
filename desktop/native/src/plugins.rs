use crate::{dsh::Dsh, state::private_file};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, env, io::Read, path::Path, sync::Arc};

#[async_trait]
pub(crate) trait Adapter: Send + Sync {
    fn id(&self) -> &str;
    async fn info(&self) -> Value;
    async fn status(&self) -> Value;
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>>;
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
            )?;
            let id = dsh.id().to_owned();
            ensure!(
                plugins.insert(id, Arc::new(dsh)).is_none(),
                "DSH 实例标识重复"
            );
        }
        Ok(Self(Arc::new(plugins)))
    }

    pub(crate) fn get(&self, id: &str) -> Option<&dyn Adapter> {
        self.0.get(id).map(AsRef::as_ref)
    }

    pub(crate) async fn infos(&self) -> Vec<Value> {
        let mut plugins: Vec<_> = self.0.values().collect();
        plugins.sort_unstable_by_key(|plugin| plugin.id());
        futures::future::join_all(plugins.into_iter().map(|plugin| plugin.info())).await
    }
}
