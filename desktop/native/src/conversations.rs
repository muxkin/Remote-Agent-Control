use crate::{
    app_tools::{self, AppTools, Tool},
    codex::History,
    codex_live::{Desktop, Outcome, Thread},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::time::timeout;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: Uuid,
    title: Option<String>,
    prompt: Option<String>,
    project_id: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    last_turn_id: Option<String>,
}

#[derive(Serialize)]
pub enum Change {
    Open,
    Rename(String),
    Fork,
    ForkReply(String),
    Create {
        title: Option<String>,
        prompt: String,
        project_id: Option<String>,
        model: Option<String>,
        thinking: Option<String>,
    },
}

impl Request {
    pub fn parse(mut self, method: &str) -> Result<(Uuid, Change)> {
        let creating = method == "thread.create";
        let renaming = method == "thread.rename";
        ensure!(
            (method == "thread.fork" || self.last_turn_id.is_none())
                && (creating
                    || (self.prompt.is_none()
                        && self.project_id.is_none()
                        && self.model.is_none()
                        && self.thinking.is_none()))
                && (creating || renaming || self.title.is_none()),
            "会话操作参数无效"
        );
        let title = self.title.take().map(|title| title.trim().to_owned());
        ensure!(
            title
                .as_ref()
                .is_none_or(|title| title.encode_utf16().count() <= 160
                    && !title.chars().any(char::is_control)),
            "会话名称无效"
        );
        let change = match method {
            "thread.open" => Change::Open,
            "thread.fork" => match self.last_turn_id {
                None => Change::Fork,
                Some(turn) => {
                    ensure!(
                        (1..=200).contains(&turn.encode_utf16().count())
                            && !turn.chars().any(char::is_control),
                        "回复 ID 无效"
                    );
                    Change::ForkReply(turn)
                }
            },
            "thread.rename" => Change::Rename(
                title
                    .filter(|title| !title.is_empty())
                    .context("请输入名称")?,
            ),
            "thread.create" => {
                let prompt = self.prompt.as_deref().unwrap_or_default().trim();
                ensure!(
                    !prompt.is_empty() && prompt.encode_utf16().count() <= 16_000,
                    "请输入第一条消息"
                );
                for (value, max) in [
                    (&self.project_id, 200),
                    (&self.model, 500),
                    (&self.thinking, 40),
                ] {
                    ensure!(
                        value.as_ref().is_none_or(|value| !value.is_empty()
                            && value.encode_utf16().count() <= max
                            && !value.chars().any(char::is_control)),
                        "新会话选项无效"
                    );
                }
                Change::Create {
                    title: title.filter(|title| !title.is_empty()),
                    prompt: prompt.to_owned(),
                    project_id: self.project_id,
                    model: self.model,
                    thinking: self.thinking,
                }
            }
            _ => anyhow::bail!("会话操作不支持"),
        };
        Ok((self.request_id, change))
    }
}

impl Change {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Rename(_) => "rename",
            Self::Fork | Self::ForkReply(_) => "fork",
            Self::Create { .. } => "create",
        }
    }

    pub async fn execute(
        self,
        desktop: Desktop,
        history: History,
        thread: String,
        live: Option<Arc<Thread>>,
        request: Uuid,
    ) -> Outcome {
        let ready = |view: &Option<Arc<crate::codex_live::View>>| {
            view.as_ref().is_some_and(|view| {
                view.thread["synchronized"] == true
                    && view.thread["owner"] == true
                    && view.thread["runtimeStatus"] != "notLoaded"
            })
        };
        if matches!(self, Self::Open) {
            let Some(live) = &live else {
                return Outcome::Rejected("请先在工作台选择会话");
            };
            if ready(&live.view.borrow()) {
                return Outcome::Completed(None);
            }
        }
        let lookup = history.clone();
        let lookup_thread = thread.clone();
        let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&lookup_thread))
            .await
            .ok()
            .and_then(Result::ok);
        let Some(anchor) = anchor else {
            return Outcome::Rejected("找不到本机会话");
        };
        let tools = desktop.tools;
        let (tool, arguments) = match self {
            Self::ForkReply(turn) => {
                if !live.is_some_and(|live| live.has_reply(&turn)) {
                    return Outcome::Rejected("所选回复不在实时会话中，请刷新后重试");
                }
                return desktop
                    .reply_fork
                    .fork(history.home(), &anchor, &turn)
                    .await;
            }

            Self::Open => (Tool::Open, json!({"threadId":thread})),
            Self::Rename(title) => (
                Tool::Rename,
                json!({"source":"codex","threadId":thread,"title":title}),
            ),
            Self::Fork => (
                Tool::Fork,
                json!({"threadId":thread,"environment":{"type":"same-directory"}}),
            ),
            Self::Create {
                title,
                prompt,
                project_id,
                model,
                thinking,
            } => {
                if model.is_some() || thinking.is_some() {
                    let lookup = history.clone();
                    let catalog = tokio::task::spawn_blocking(move || lookup.models()).await;
                    let valid = catalog.ok().and_then(Result::ok).is_some_and(|catalog| {
                        catalog["models"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|entry| {
                                model.as_deref().is_some_and(|id| entry["id"] == id)
                                    && thinking.as_deref().is_none_or(|effort| {
                                        entry["efforts"].as_array().is_some_and(|levels| {
                                            levels.iter().any(|level| level == effort)
                                        })
                                    })
                            })
                    });
                    if !valid {
                        return Outcome::Rejected("模型或推理强度不在桌面目录中，请重新选择");
                    }
                }
                let mut args = json!({"prompt":prompt,"target":{"type":"projectless"}});
                for (key, value) in [("title", title), ("model", model), ("thinking", thinking)] {
                    if let Some(value) = value {
                        args[key] = json!(value);
                    }
                }
                if let Some(id) = project_id {
                    let Ok(projects) = projects(&tools, history, &anchor).await else {
                        return Outcome::Rejected("无法读取桌面项目，请重新选择");
                    };
                    let Some(project) = projects
                        .iter()
                        .find(|project| project.id == id || project.desktop_id == id)
                    else {
                        return Outcome::Rejected("所选桌面项目已不可用");
                    };
                    args["target"] = json!({"type":"project","projectId":project.desktop_id,"environment":{"type":"local"}});
                }
                (Tool::Create, args)
            }
        };
        let Ok(mut stream) = tools.connect(tool).await else {
            return Outcome::Rejected("Codex 桌面未提供此操作");
        };
        let reply = app_tools::call(&mut stream, &anchor, request, tool, arguments).await;
        if matches!(tool, Tool::Open) {
            let mut receiver = live.expect("open requires a subscription").view.clone();
            if timeout(Duration::from_secs(12), receiver.wait_for(ready))
                .await
                .is_ok_and(|result| result.is_ok())
            {
                return Outcome::Completed(None);
            }
            return Outcome::Uncertain;
        }
        let Ok(reply) = reply else {
            return Outcome::Uncertain;
        };
        if matches!(tool, Tool::Rename) {
            return Outcome::Completed(None);
        }
        let local =
            reply["hostId"] == "local" || (matches!(tool, Tool::Fork) && reply["hostId"].is_null());
        let result = reply["threadId"]
            .as_str()
            .filter(|id| *id != thread)
            .and_then(|id| Uuid::parse_str(id).ok());
        match result {
            Some(result) if local => Outcome::Completed(Some(result)),
            _ => Outcome::Uncertain,
        }
    }
}

#[derive(Serialize)]
pub struct Project {
    id: String,
    name: String,
    #[serde(skip)]
    desktop_id: String,
}

pub async fn projects(tools: &AppTools, history: History, anchor: &str) -> Result<Vec<Project>> {
    let mut stream = tools.connect(Tool::Projects).await?;
    let result = timeout(
        Duration::from_secs(4),
        app_tools::call(
            &mut stream,
            anchor,
            Uuid::new_v4(),
            Tool::Projects,
            json!({}),
        ),
    )
    .await??;
    let aliases = tokio::task::spawn_blocking(move || history.project_aliases()).await??;
    let projects = result["projects"].as_array().context("桌面项目列表无效")?;
    Ok(projects
        .iter()
        .filter(|project| project["hostId"] == "local" && project["projectKind"] == "local")
        .filter_map(|project| {
            let desktop_id = project["projectId"].as_str()?;
            Some(Project {
                id: aliases[desktop_id]
                    .as_str()
                    .unwrap_or(desktop_id)
                    .to_owned(),
                name: project["label"].as_str().unwrap_or(desktop_id).to_owned(),
                desktop_id: desktop_id.to_owned(),
            })
        })
        .collect())
}
