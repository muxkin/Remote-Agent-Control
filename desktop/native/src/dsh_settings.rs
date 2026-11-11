use crate::{
    dsh::{Dsh, Refused, Session},
    plugins::{Control, CreationSettings, Delivery, GoalOperation, GoalRef, ModelSettings},
    state::hash,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{sleep, timeout};

pub(crate) const PROJECTIONS: &[&str] = &[
    "modelSelection",
    "permissions",
    "agentPreset",
    "plan",
    "turnOutline",
    "imageLimits",
    "userQuestions",
];

pub(crate) fn model(selection: &Value) -> Option<String> {
    let provider = selection["provider"].as_str()?;
    let model = selection["model"].as_str()?;
    Some(json!([provider, model]).to_string())
}

pub(crate) fn effort(selection: &Value) -> &str {
    selection["reasoningEffort"].as_str().unwrap_or("default")
}

pub(crate) fn mode(projections: &Value) -> &'static str {
    if projections["plan"]["active"] == true {
        "plan"
    } else {
        "default"
    }
}

pub(crate) fn state(projections: &Value) -> Value {
    let permission = &projections["permissions"];
    json!({
        "permission": permission["currentValue"],
        "permissionRevision": permission.is_object().then(|| hash(&permission.to_string())),
        "preset": projections["agentPreset"],
        "presetLocked": projections["turnOutline"].as_array().is_some_and(|turns| !turns.is_empty()),
        "plan": mode(projections) == "plan",
    })
}

#[derive(Deserialize)]
struct ModelCatalog {
    groups: Vec<ModelGroup>,
}

#[derive(Deserialize)]
struct ModelGroup {
    id: String,
    name: String,
    models: Vec<NativeModel>,
}

#[derive(Deserialize)]
struct NativeModel {
    id: String,
    name: String,
    reasoning: Option<Reasoning>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reasoning {
    efforts: Vec<Effort>,
    default_effort: Option<String>,
}

#[derive(Deserialize)]
struct Effort {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    id: String,
    name: String,
    efforts: Vec<String>,
    default_effort: String,
    speeds: [String; 0],
}

pub(crate) struct Selection {
    provider: String,
    model: String,
    effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionCatalog {
    default_preset: String,
    options: Vec<PermissionOption>,
}

#[derive(Deserialize, Serialize)]
struct PermissionOption {
    #[serde(rename(deserialize = "value"))]
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Deserialize)]
struct Presets {
    presets: Vec<Preset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: String,
    name: Option<String>,
    description: Option<String>,
    is_default: bool,
    broken: Option<String>,
}

#[derive(Deserialize)]
struct Command {
    name: String,
}

impl Dsh {
    async fn model_choices(&self) -> Result<Vec<Choice>> {
        let catalog: ModelCatalog =
            serde_json::from_value(self.call("session/modelCatalog", json!({})).await?)?;
        let mut choices = Vec::new();
        for group in catalog.groups {
            for model in group.models {
                let (mut efforts, default_effort) = model.reasoning.map_or_else(
                    || (Vec::new(), None),
                    |r| {
                        (
                            r.efforts.into_iter().map(|e| e.id).collect(),
                            r.default_effort,
                        )
                    },
                );
                if efforts.is_empty() {
                    efforts.push("default".to_owned());
                }
                choices.push(Choice {
                    id: json!([group.id, model.id]).to_string(),
                    name: format!("{} / {}", group.name, model.name),
                    efforts,
                    default_effort: default_effort.unwrap_or_else(|| "default".to_owned()),
                    speeds: [],
                });
            }
        }
        Ok(choices)
    }

    pub(crate) async fn models(&self) -> Result<Value> {
        Ok(json!({"source":"dsh-native","fetchedAt":null,"models":self.model_choices().await?}))
    }

    async fn selection(&self, id: &str, effort: Option<&str>) -> Result<Selection> {
        ensure!(
            (1..=500).contains(&id.encode_utf16().count()),
            "DSH 模型无效"
        );
        let [provider, model] = serde_json::from_str::<[String; 2]>(id)?;
        let choice = self
            .model_choices()
            .await?
            .into_iter()
            .find(|choice| choice.id == id)
            .context("模型不在 DSH 原生目录中")?;
        if let Some(effort) = effort {
            ensure!(
                (1..=40).contains(&effort.len()) && choice.efforts.iter().any(|id| id == effort),
                "推理强度不在 DSH 原生目录中"
            );
        }
        Ok(Selection {
            provider,
            model,
            effort: effort
                .filter(|effort| *effort != "default")
                .map(str::to_owned),
        })
    }

    pub(crate) async fn select_model(
        &self,
        session: &Session,
        thread: &str,
        selection: Selection,
    ) -> Result<()> {
        let mut request =
            json!({"sessionId":thread,"provider":selection.provider,"model":selection.model});
        if let Some(effort) = &selection.effort {
            request["reasoningEffort"] = json!(effort);
        }
        let result = self
            .exchange(session, "session/selectModel", json!({"request":request}))
            .await?;
        let selected = &result["selected"];
        ensure!(
            selected["provider"] == selection.provider
                && selected["model"] == selection.model
                && selection
                    .effort
                    .as_ref()
                    .is_none_or(|effort| selected["reasoningEffort"] == *effort),
            "DSH 模型切换尚未确认"
        );
        Ok(())
    }

    pub(crate) async fn projections(&self, thread: &str) -> Result<Value> {
        let mut result = self
            .call(
                "session/projections",
                json!({"request":{"sessionId":thread}}),
            )
            .await?;
        ensure!(
            result["kind"] == "sequenced" && result["values"].is_object(),
            "DSH 设置尚未同步"
        );
        Ok(result["values"].take())
    }

    async fn permissions(&self) -> Result<PermissionCatalog> {
        Ok(serde_json::from_value(
            self.call("permissionPresets/catalog", json!({})).await?,
        )?)
    }

    async fn presets(&self) -> Result<Vec<Preset>> {
        let roster: Presets =
            serde_json::from_value(self.call("agentPresets/list", json!({})).await?)?;
        Ok(roster
            .presets
            .into_iter()
            .filter(|p| p.broken.is_none())
            .collect())
    }

    async fn commands(&self, thread: &str) -> Result<Vec<Command>> {
        Ok(serde_json::from_value(
            self.call("commands/list", json!({"agentId":thread}))
                .await?,
        )?)
    }

    pub(crate) async fn controls(&self, thread: &str, read_only: bool) -> Result<Value> {
        let (permissions, presets) = tokio::join!(self.permissions(), self.presets());
        let (mut permissions, presets) = (permissions.ok(), presets.unwrap_or_default());
        if let Some(catalog) = &mut permissions {
            catalog.options.retain(|option| permission_id(&option.id));
        }
        let has_presets = !presets.is_empty();
        let (state, mut actions, goal) = if thread == "new" {
            let mut actions = Vec::new();
            if permissions.is_some() {
                actions.push("permission");
            }
            if has_presets {
                actions.push("preset");
            }
            (
                json!({
                    "permission":permissions.as_ref().map(|p| &p.default_preset),
                    "preset":presets.iter().find(|p| p.is_default).map(|p| &p.id),
                    "plan":false,
                }),
                actions,
                Value::Null,
            )
        } else {
            let (projections, commands) =
                tokio::join!(self.projections(thread), self.commands(thread));
            let projections = projections?;
            let commands = commands.unwrap_or_default();
            let mut actions = Vec::new();
            if permissions.is_some()
                && projections["permissions"].is_object()
                && commands.iter().any(|c| c.name == "permission")
            {
                actions.push("permission");
            }
            if has_presets && projections.get("agentPreset").is_some() {
                actions.push("preset");
            }
            for action in ["plan", "compact", "feedback"] {
                if commands.iter().any(|c| c.name == action) {
                    actions.push(action);
                }
            }
            let mut goal = Value::Null;
            if commands.iter().any(|c| c.name == "goal")
                && let Ok(value) = self.call("goals/get", json!({"agentId":thread})).await
                && let Some(value) = goal_catalog(value)
            {
                actions.push("goal");
                goal = value;
            }
            (state(&projections), actions, goal)
        };
        if read_only {
            actions.clear();
        }
        Ok(json!({
            "product":"dsh", "state":state, "actions":actions, "goal":goal,
            "permissions":permissions.map(|p| p.options).unwrap_or_default(),
            "presets":presets.iter().map(|p| json!({
                "id":p.id, "name":p.name.as_ref().unwrap_or(&p.id), "description":p.description
            })).collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn change_model(
        &self,
        session: &Session,
        thread: &str,
        settings: ModelSettings,
    ) -> Delivery {
        if settings
            .service_tier
            .as_deref()
            .is_some_and(|tier| tier != "default")
            || settings.expected_service_tier.is_some()
        {
            return Delivery::Rejected("DSH 不支持此服务档位");
        }
        let Ok(selection) = self
            .selection(&settings.model, Some(&settings.effort))
            .await
        else {
            return Delivery::Rejected("模型设置不在 DSH 原生目录中");
        };
        let Ok(projections) = self.projections(thread).await else {
            return Delivery::Rejected("DSH 设置尚未同步");
        };
        let current = &projections["modelSelection"]["next"];
        if settings.expected_model != model(current)
            || settings.expected_effort.as_deref() != Some(effort(current))
            || [settings.mode, settings.expected_mode]
                .into_iter()
                .flatten()
                .any(|value| value.name() != mode(&projections))
        {
            return Delivery::Rejected("DSH 模型或计划模式已变化，请刷新");
        }
        delivery(self.select_model(session, thread, selection).await)
    }

    pub(crate) async fn creation_selection(
        &self,
        settings: &CreationSettings,
    ) -> Result<Option<Selection>> {
        if let Some(value) = &settings.permission {
            ensure!(
                permission_id(value)
                    && self
                        .permissions()
                        .await?
                        .options
                        .iter()
                        .any(|option| option.id == *value),
                "DSH 权限选项无效"
            );
        }
        if let Some(value) = &settings.preset {
            ensure!(
                self.presets().await?.iter().any(|p| p.id == *value),
                "DSH Agent 预设无效"
            );
        }
        if let Some(model) = &settings.model {
            return self
                .selection(model, settings.thinking.as_deref())
                .await
                .map(Some);
        }
        ensure!(settings.thinking.is_none(), "选择推理强度前需要指定模型");
        Ok(None)
    }

    async fn native_command(
        &self,
        session: &Session,
        thread: &str,
        line: &str,
    ) -> Result<(String, bool)> {
        let result = self
            .exchange(
                session,
                "commands/execute",
                json!({
                    "agentId":thread,"line":line,"submittedAttachments":[]
                }),
            )
            .await?;
        let id = result["commandId"]
            .as_str()
            .filter(|id| valid_identity(id))
            .context("DSH 原生命令未确认")?;
        let kind = result["result"]["kind"]
            .as_str()
            .context("DSH 原生命令未确认")?;
        ensure!(matches!(kind, "success" | "error"), "DSH 原生命令未确认");
        Ok((id.to_owned(), kind == "success"))
    }

    async fn execute_command(&self, session: &Session, thread: &str, line: &str) -> Result<()> {
        match self.native_command(session, thread, line).await? {
            (_, true) => Ok(()),
            (_, false) => Err(Refused.into()),
        }
    }

    pub(crate) async fn change_control(
        &self,
        session: &Session,
        thread: &str,
        control: Control,
    ) -> Delivery {
        let Ok(catalog) = self.controls(thread, false).await else {
            return Delivery::Rejected("DSH 设置尚未同步");
        };
        let allows = |action: &str| {
            catalog["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|value| value == action)
        };
        let current = &catalog["state"];
        let (field, value, applied) = match control {
            Control::Permission {
                value,
                expected,
                expected_revision,
            } => {
                if !allows("permission")
                    || current["permission"].as_str() != expected.as_deref()
                    || expected_revision
                        .as_ref()
                        .is_some_and(|revision| current["permissionRevision"] != *revision)
                    || !catalog["permissions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|option| option["id"] == value)
                {
                    return Delivery::Rejected("DSH 权限已变化或选项不可用，请刷新");
                }
                let result = self
                    .execute_command(session, thread, &format!("/permission {value}"))
                    .await;
                ("permission", json!(value), result)
            }
            Control::Preset { value } => {
                if !allows("preset")
                    || current["presetLocked"] == true
                    || !catalog["presets"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|p| p["id"] == value)
                {
                    return Delivery::Rejected("DSH Agent 预设已锁定或不可用");
                }
                let result = self
                    .exchange(
                        session,
                        "agentPresets/select",
                        json!({
                            "agentId":thread,"agentPreset":value
                        }),
                    )
                    .await
                    .and_then(|result| {
                        ensure!(result == value, "DSH Agent 预设尚未确认");
                        Ok(())
                    });
                ("preset", json!(value), result)
            }
            Control::Plan { enabled } => {
                if !allows("plan") {
                    return Delivery::Rejected("DSH 会话未提供计划模式");
                }
                if current["plan"] == enabled {
                    return Delivery::Completed(None);
                }
                let result = self
                    .execute_command(session, thread, if enabled { "/plan" } else { "/plan off" })
                    .await;
                ("plan", json!(enabled), result)
            }
            Control::Compact => {
                if !allows("compact") {
                    return Delivery::Rejected("DSH 会话未提供压缩操作");
                }
                return match self.native_command(session, thread, "/compact").await {
                    Ok((id, succeeded)) => Delivery::Command { id, succeeded },
                    Err(error) => delivery(Err(error)),
                };
            }
            Control::Feedback { text } => {
                let text = text.trim();
                if !allows("feedback") || !(1..=16_000).contains(&text.encode_utf16().count()) {
                    return Delivery::Rejected("DSH 反馈不可用或内容无效");
                }
                return match self
                    .exchange(
                        session,
                        "sessionFeedback/record",
                        json!({"request":{"sessionId":thread,"text":text}}),
                    )
                    .await
                {
                    Ok(value) if value["ok"] == true => Delivery::Completed(None),
                    Ok(value)
                        if value["ok"] == false
                            && value["error"]["code"] == "session-not-found" =>
                    {
                        Delivery::Rejected("DSH 会话不存在")
                    }
                    Ok(_) => Delivery::Uncertain,
                    Err(error) => delivery(Err(error)),
                };
            }
            Control::Goal {
                operation,
                reference,
                objective,
            } => {
                if !allows("goal") {
                    return Delivery::Rejected("DSH 会话未提供目标管理");
                }
                return self
                    .change_goal(
                        session,
                        thread,
                        operation,
                        reference,
                        objective,
                        &catalog["goal"],
                    )
                    .await;
            }
        };
        if let Err(error) = applied {
            return delivery(Err(error));
        }
        let confirmed = timeout(Duration::from_secs(3), async {
            while let Ok(projections) = self.projections(thread).await {
                if state(&projections)[field] == value {
                    return true;
                }
                sleep(Duration::from_millis(200)).await;
            }
            false
        })
        .await;
        if matches!(confirmed, Ok(true)) {
            Delivery::Completed(None)
        } else {
            Delivery::Uncertain
        }
    }

    async fn change_goal(
        &self,
        session: &Session,
        thread: &str,
        operation: GoalOperation,
        reference: Option<GoalRef>,
        objective: Option<String>,
        current: &Value,
    ) -> Delivery {
        let mut args = json!({"agentId":thread});
        if matches!(operation, GoalOperation::Create) {
            if reference.is_some() || (!current.is_null() && current["phase"] != "complete") {
                return Delivery::Rejected("DSH 目标已存在，请刷新");
            }
        } else if let Some(reference) = &reference
            && valid_identity(&reference.id)
            && reference.revision > 0
            && current["ref"]["id"] == reference.id
            && current["ref"]["revision"] == reference.revision
        {
            args["ref"] = json!(reference);
        } else {
            return Delivery::Rejected("DSH 目标已变化，请刷新");
        }
        if matches!(operation, GoalOperation::Create | GoalOperation::Edit) {
            let Some(objective) = objective
                .as_deref()
                .map(str::trim)
                .filter(|text| (1..=16_000).contains(&text.encode_utf16().count()))
            else {
                return Delivery::Rejected("DSH 目标内容无效");
            };
            args["request"] = json!({"objective":objective});
        } else if objective.is_some() {
            return Delivery::Rejected("DSH 目标参数无效");
        }
        let endpoint = match operation {
            GoalOperation::Create => "goals/create",
            GoalOperation::Edit => "goals/edit",
            GoalOperation::Pause => "goals/pause",
            GoalOperation::Resume => "goals/resume",
            GoalOperation::Complete => "goals/complete",
            GoalOperation::Clear => "goals/clear",
        };
        match self.exchange(session, endpoint, args).await {
            Ok(value) => {
                let confirmed = if let Some(reference) = reference {
                    value["id"] == reference.id
                        && reference
                            .revision
                            .checked_add(1)
                            .is_some_and(|revision| value["revision"] == revision)
                } else {
                    goal_identity(&value["ref"]).is_some()
                };
                if confirmed {
                    Delivery::Completed(None)
                } else {
                    Delivery::Uncertain
                }
            }
            Err(error) => delivery(Err(error)),
        }
    }

    pub(crate) async fn skills(&self, thread: &str) -> Result<Vec<Value>> {
        let data = self
            .call("skills/list", json!({"request":{"sessionId":thread}}))
            .await?;
        Ok(data["skills"].as_array().context("DSH 技能目录无效")?.iter().filter_map(|skill| {
            let name = skill["name"].as_str().filter(|name| skill_name(name))?;
            Some(json!({
                "id":name,"name":name,"description":skill["description"].as_str().unwrap_or_default(),
                "source":skill["path"].as_str().unwrap_or("DSH"),
            }))
        }).collect())
    }

    pub(crate) async fn skill_prompt(
        &self,
        thread: &str,
        text: String,
        skills: Vec<String>,
    ) -> Result<String> {
        if skills.is_empty() {
            return Ok(text);
        }
        let available = self.skills(thread).await?;
        ensure!(
            skills
                .iter()
                .all(|name| available.iter().any(|skill| skill["id"] == *name)),
            "DSH 技能已失效"
        );
        let mut prompt = skills
            .into_iter()
            .map(|name| format!("/{name}"))
            .collect::<Vec<_>>();
        if !text.is_empty() {
            prompt.push(text);
        }
        Ok(prompt.join("\n"))
    }

    pub(crate) async fn initialize_controls(
        &self,
        session: &Session,
        thread: &str,
        settings: CreationSettings,
    ) -> bool {
        if settings.permission.is_none() && settings.plan.is_none() {
            return true;
        }
        let Ok(projections) = self.projections(thread).await else {
            return false;
        };
        if let Some(permission) = settings.permission
            && projections["permissions"]["currentValue"] != permission
            && !matches!(
                self.change_control(
                    session,
                    thread,
                    Control::Permission {
                        value: permission,
                        expected: projections["permissions"]["currentValue"]
                            .as_str()
                            .map(str::to_owned),
                        expected_revision: None,
                    }
                )
                .await,
                Delivery::Completed(_)
            )
        {
            return false;
        }
        if let Some(enabled) = settings.plan
            && (mode(&projections) == "plan") != enabled
            && !matches!(
                self.change_control(session, thread, Control::Plan { enabled })
                    .await,
                Delivery::Completed(_)
            )
        {
            return false;
        }
        true
    }
}

pub(crate) fn skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_identity(id: &str) -> bool {
    (1..=200).contains(&id.encode_utf16().count()) && !id.chars().any(char::is_control)
}

fn goal_identity(value: &Value) -> Option<(&str, u64)> {
    Some((
        value["id"].as_str().filter(|id| valid_identity(id))?,
        value["revision"]
            .as_u64()
            .filter(|&revision| revision > 0)?,
    ))
}

fn goal_catalog(value: Value) -> Option<Value> {
    if value.is_null() {
        return Some(value);
    }
    let (id, revision) = goal_identity(&value)?;
    let objective = value["objective"].as_str()?;
    let phase = value["phase"]
        .as_str()
        .filter(|phase| matches!(*phase, "active" | "paused" | "blocked" | "complete"))?;
    Some(
        json!({"ref":{"id":id,"revision":revision},"objective":objective,"phase":phase,
        "activation":value["activation"].as_str()}),
    )
}

fn permission_id(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'))
}

fn delivery(result: Result<()>) -> Delivery {
    match result {
        Ok(()) => Delivery::Completed(None),
        Err(error) if error.is::<Refused>() => Delivery::Rejected("DSH 拒绝更新设置"),
        Err(_) => Delivery::Uncertain,
    }
}
