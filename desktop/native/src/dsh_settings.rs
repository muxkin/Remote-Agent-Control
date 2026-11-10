use crate::{
    dsh::{Dsh, Refused, Session},
    plugins::{Control, CreationSettings, Delivery, ModelSettings},
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

    async fn projections(&self, thread: &str) -> Result<Value> {
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
        let (state, mut actions) = if thread == "new" {
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
            if commands.iter().any(|c| c.name == "plan") {
                actions.push("plan");
            }
            (state(&projections), actions)
        };
        if read_only {
            actions.clear();
        }
        Ok(json!({
            "product":"dsh", "state":state, "actions":actions,
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

    async fn execute_command(&self, session: &Session, thread: &str, line: &str) -> Result<()> {
        let result = self
            .exchange(
                session,
                "commands/execute",
                json!({
                    "agentId":thread,"line":line,"submittedAttachments":[]
                }),
            )
            .await?;
        ensure!(result["commandId"].as_str().is_some(), "DSH 原生命令未确认");
        if result["result"]["kind"] == "error" {
            return Err(Refused.into());
        }
        ensure!(result["result"]["kind"] == "success", "DSH 原生命令未确认");
        Ok(())
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
