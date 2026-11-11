#[cfg(feature = "official-plugins")]
use crate::{
    app_tools::Tool,
    codex::History,
    codex_live::{Action, Desktop, Outcome, Thread},
    codex_peer::Endpoint,
    conversations, history_media, settings,
};
#[cfg(feature = "official-plugins")]
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
#[cfg(feature = "official-plugins")]
use serde_json::Value;
#[cfg(feature = "official-plugins")]
use serde_json::json;
use std::path::PathBuf;
#[cfg(feature = "official-plugins")]
use std::sync::Arc;
#[cfg(feature = "official-plugins")]
use uuid::Uuid;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
pub(crate) struct Availability {
    pub history: bool,
    pub desktop: bool,
    pub open: bool,
    pub create: bool,
    pub rename: bool,
    pub fork: bool,
    pub fork_reply: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct Options {
    pub home: Option<PathBuf>,
    pub root: Option<PathBuf>,
    pub socket: Option<PathBuf>,
    pub executable: Option<PathBuf>,
    pub app_tools: Option<PathBuf>,
    pub cli: Option<PathBuf>,
    pub explicit: bool,
}

#[cfg(feature = "official-plugins")]
pub(crate) struct Local {
    history: History,
    desktop: Option<Desktop>,
}

#[cfg(feature = "official-plugins")]
impl Local {
    pub(crate) fn open(options: &Options, read_only: bool, named: bool) -> Result<Self> {
        let home = options.home.as_deref().context("尚未配置 Codex 目录")?;
        let history = History::open(home)?;
        let desktop = if read_only {
            None
        } else {
            Endpoint::discover(home, options, named)
                .map(|endpoint| Desktop::new(endpoint, history.clone(), options.cli.as_deref()))
        };
        Ok(Self { history, desktop })
    }

    pub(crate) fn availability(&self) -> Availability {
        let catalog = self
            .desktop
            .as_ref()
            .map(|desktop| desktop.tools.catalog())
            .unwrap_or_default();
        Availability {
            history: true,
            desktop: self.desktop.is_some(),
            open: catalog.has(Tool::Open),
            create: catalog.can_create(),
            rename: catalog.has(Tool::Rename),
            fork: catalog.has(Tool::Fork),
            fork_reply: self
                .desktop
                .as_ref()
                .is_some_and(|desktop| desktop.reply_fork.supported()),
        }
    }

    pub(crate) async fn refresh(&self) -> Availability {
        if let Some(desktop) = &self.desktop {
            tokio::join!(desktop.tools.refresh(), desktop.reply_fork.probe());
        }
        self.availability()
    }

    pub(crate) fn subscribe(&self, id: Uuid) -> Option<Arc<Thread>> {
        self.desktop.as_ref()?.subscribe(id)
    }

    pub(crate) async fn read(
        &self,
        method: &str,
        params: &Value,
        query: &Value,
        live: Option<&Thread>,
    ) -> Result<Option<Value>> {
        match method {
            "content.read" => {
                let id = thread_id(&params["id"])?;
                let message_id = query["messageId"]
                    .as_str()
                    .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 500)
                    .context("消息 ID 无效")?;
                if let Some(view) = live.and_then(|live| live.view.borrow().clone())
                    && let Some(mut message) = view
                        .messages
                        .iter()
                        .find(|message| message["id"] == message_id)
                        .cloned()
                {
                    if let Some(text) = view.expanded.get(message_id) {
                        message["text"] = json!(text);
                        message["truncated"] = json!(false);
                    }
                    if let Some(details) = view.activities.get(message_id) {
                        crate::tool_activity::apply_details(&mut message, details);
                    }
                    return Ok(Some(json!({"message":message})));
                }
                let history = self.history.clone();
                let message_id = message_id.to_owned();
                tokio::task::spawn_blocking(move || history.content(id, &message_id)).await?
            }
            "skills.list" | "plugins.list" => {
                let catalog = self.tools(thread_id(&params["id"])?, live).await?;
                let skills = method == "skills.list";
                let name = if skills { "skills" } else { "plugins" };
                Ok(Some(json!({name:catalog.list(skills)})))
            }
            "controls.read" => {
                params["id"].as_str().context("会话 ID 无效")?;
                let view = live.and_then(|live| live.view.borrow().clone());
                let state = view.as_ref().map_or_else(
                    || settings::permission(&Value::Null),
                    |view| view.thread["controls"].clone(),
                );
                Ok(Some(settings::controls(state, view.is_some())))
            }
            "creation.projects" => {
                let desktop = self.desktop.as_ref().context("尚未连接 Codex")?;
                let id = params["id"].as_str().context("会话 ID 无效")?.to_owned();
                let lookup = self.history.clone();
                let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&id)).await??;
                let projects =
                    conversations::projects(&desktop.tools, self.history.clone(), &anchor).await?;
                Ok(Some(json!({"projects":projects})))
            }
            "usage.read" => {
                let value = if let Some(desktop) = &self.desktop {
                    let anchor = match params["id"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                    {
                        Some(id) => Some(id),
                        None => {
                            let history = self.history.clone();
                            tokio::task::spawn_blocking(move || history.latest_thread()).await??
                        }
                    };
                    match anchor {
                        Some(id) => desktop.usage.read(id).await,
                        None => crate::usage::unavailable("暂无可用于查询用量的 Codex 会话"),
                    }
                } else {
                    crate::usage::unavailable("本机桌面用量暂不可用")
                };
                Ok(Some(value))
            }
            _ => {
                let history = self.history.clone();
                let method = method.to_owned();
                let params = params.clone();
                let query = query.clone();
                tokio::task::spawn_blocking(move || history.rpc(&method, &params, &query)).await?
            }
        }
    }

    async fn tools(
        &self,
        id: Uuid,
        live: Option<&Thread>,
    ) -> Result<crate::tools_catalog::Catalog> {
        let history = self.history.clone();
        let disabled = live
            .and_then(|live| {
                live.view
                    .borrow()
                    .as_ref()
                    .map(|view| view.disabled_plugins.clone())
            })
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || history.tools(id, &disabled)).await?
    }

    pub(crate) async fn select_tools(
        &self,
        id: Uuid,
        live: Option<&Thread>,
        skills: &[String],
        plugins: &[String],
    ) -> Result<Vec<Value>> {
        self.tools(id, live).await?.select(skills, plugins)
    }

    pub(crate) async fn media(
        &self,
        backend: String,
        thread: Uuid,
        device: String,
        reference: String,
        live: Option<&Thread>,
    ) -> Result<history_media::Source> {
        let history = self.history.clone();
        let view = live.and_then(|live| live.view.borrow().clone());
        tokio::task::spawn_blocking(move || {
            history_media::description(
                &history,
                &backend,
                thread,
                &device,
                &reference,
                view.as_deref(),
            )
        })
        .await?
    }

    pub(crate) async fn manage(
        &self,
        request: Uuid,
        change: conversations::Change,
        thread: String,
        live: Option<Arc<Thread>>,
    ) -> Outcome {
        let Some(desktop) = &self.desktop else {
            return Outcome::Rejected("尚未连接 Codex".into());
        };
        change
            .execute(desktop.clone(), self.history.clone(), thread, live, request)
            .await
    }

    pub(crate) async fn execute(live: Option<&Thread>, request: Uuid, action: Action) -> Outcome {
        match live {
            Some(live) => live.execute(action, request).await,
            None => Outcome::Rejected("请先打开会话".into()),
        }
    }
}

#[cfg(feature = "official-plugins")]
pub(crate) fn thread_id(value: &Value) -> Result<Uuid> {
    Ok(Uuid::parse_str(value.as_str().context("会话 ID 无效")?)?)
}
