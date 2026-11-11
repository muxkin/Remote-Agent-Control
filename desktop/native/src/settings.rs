use anyhow::{Context, Result, ensure};
use serde_json::Value;
#[cfg(feature = "official-plugins")]
use serde_json::json;

#[cfg(feature = "official-plugins")]
use crate::{codex_live::View, state::hash};

const PERMISSIONS: [(&str, &str, &str); 3] = [
    (":read-only", "只读", "readOnly"),
    (":workspace", "工作区内修改", "workspaceWrite"),
    (":danger-full-access", "完全访问", "dangerFullAccess"),
];

#[cfg(feature = "official-plugins")]
pub fn controls(state: Value, live: bool) -> Value {
    let permissions: Vec<_> = PERMISSIONS
        .iter()
        .map(|(id, name, _)| json!({"id":id,"name":name}))
        .collect();
    json!({"product":"codex","permissions":permissions,"presets":[],
        "actions": if live { vec!["permission"] } else { Vec::new() }, "state":state})
}

#[cfg(feature = "official-plugins")]
pub fn permission(settings: &Value) -> Value {
    let profile = settings["activePermissionProfile"]["id"].as_str();
    let sandbox = settings["sandboxPolicy"]["type"].as_str();
    let policy = settings["approvalPolicy"].as_str();
    let proof = json!([
        settings["activePermissionProfile"],
        settings["sandboxPolicy"],
        settings["approvalPolicy"],
        settings["approvalsReviewer"]
    ]);
    let description = if settings.is_null() {
        "沿用 Codex 创建权限".into()
    } else {
        format!(
            "沙箱 {}，审批 {}",
            sandbox.or(profile).unwrap_or("原生默认"),
            policy.unwrap_or("自定义")
        )
    };
    json!({"permission":profile.or(sandbox.map(|_| "custom")),"permissionRevision":hash(&proof.to_string()),
        "permissionDescription":description})
}

#[cfg(feature = "official-plugins")]
fn approval(id: &str) -> &'static str {
    if id == ":danger-full-access" {
        "never"
    } else {
        "on-request"
    }
}

pub fn permission_change(body: &Value) -> Result<Value> {
    let control = body.as_object().context("会话权限参数无效")?;
    ensure!(
        control.len() == 4 && body["action"] == "permission",
        "会话权限参数无效"
    );
    let id = body["value"].as_str().context("会话权限参数无效")?;
    ensure!(
        PERMISSIONS.iter().any(|option| option.0 == id),
        "权限选项无效"
    );
    ensure!(
        body.get("expected").is_some_and(
            |value| value.is_null() || value.as_str().is_some_and(|value| value.len() <= 200)
        ),
        "会话权限参数无效"
    );
    ensure!(
        body["expectedRevision"]
            .as_str()
            .is_some_and(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())),
        "请重新打开权限面板"
    );
    Ok(body.clone())
}

#[cfg(feature = "official-plugins")]
pub fn permission_request(view: &View, input: &Value) -> Result<Value> {
    let state = &view.thread["controls"];
    ensure!(
        state["permission"] == input["expected"]
            && state["permissionRevision"] == input["expectedRevision"],
        "会话权限已变化"
    );
    let id = input["value"].as_str().context("权限选项无效")?;
    Ok(json!({"permissions":id,"approvalPolicy":approval(id),"approvalsReviewer":"user"}))
}

#[cfg(feature = "official-plugins")]
pub fn permission_applied(native: &Value, input: &Value) -> bool {
    PERMISSIONS.iter().any(|(id, _, sandbox)| {
        input["value"] == *id
            && native["activePermissionProfile"]["id"] == *id
            && native["sandboxPolicy"]["type"] == *sandbox
            && native["approvalPolicy"] == approval(id)
    })
}

pub fn model_change(body: &Value, catalog: &Value) -> Result<Value> {
    let values = body.as_object().context("模型设置无效")?;
    let allowed = [
        "model",
        "effort",
        "mode",
        "serviceTier",
        "expectedModel",
        "expectedEffort",
        "expectedMode",
        "expectedServiceTier",
    ];
    ensure!(
        values.keys().all(|key| allowed.contains(&key.as_str())),
        "模型设置无效"
    );
    for key in ["expectedModel", "expectedEffort", "expectedServiceTier"] {
        if key == "expectedServiceTier" && body.get(key).is_none() {
            continue;
        }
        ensure!(
            body.get(key).is_some_and(|value| value.is_null()
                || value
                    .as_str()
                    .is_some_and(|value| (1..=500).contains(&value.len()))),
            "模型设置无效"
        );
    }
    for key in ["mode", "expectedMode"] {
        ensure!(
            body.get(key)
                .is_none_or(|value| matches!(value.as_str(), Some("default" | "plan"))),
            "计划模式无效"
        );
    }
    let id = body["model"].as_str().context("模型无效")?;
    let effort = body["effort"].as_str().context("推理强度无效")?;
    let model = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|model| model["id"] == id)
        .context("模型不在桌面目录中")?;
    ensure!(
        model["efforts"]
            .as_array()
            .is_some_and(|efforts| efforts.iter().any(|level| level == effort)),
        "推理强度不在桌面目录中"
    );
    if let Some(tier) = body.get("serviceTier") {
        ensure!(
            tier.is_string()
                && model["speeds"]
                    .as_array()
                    .is_some_and(|speeds| speeds.iter().any(|speed| speed["id"] == *tier)),
            "速度不在桌面目录中"
        );
    }
    Ok(body.clone())
}

#[cfg(feature = "official-plugins")]
pub fn model_request(view: &View, input: &Value) -> Result<Value> {
    ensure!(
        view.thread["canSend"] == true || view.thread["canInterrupt"] == true,
        "当前会话不能修改模型设置"
    );
    for (key, field) in [
        ("expectedModel", "model"),
        ("expectedEffort", "reasoningEffort"),
        ("expectedMode", "mode"),
        ("expectedServiceTier", "serviceTier"),
    ] {
        ensure!(
            input
                .get(key)
                .is_none_or(|value| *value == view.thread[field]),
            "桌面设置已变化"
        );
    }
    let mut native = json!({"model":input["model"],"effort":input["effort"]});
    if let Some(tier) = input.get("serviceTier") {
        native["serviceTier"] = tier.clone();
    }
    if let Some(mode) = input.get("mode") {
        native["collaborationMode"] = json!({"mode":mode,"settings":{
            "model":input["model"],"reasoning_effort":input["effort"],"developer_instructions":null}});
    }
    Ok(native)
}
