use crate::{
    codex_live::{View, native_text, ordered},
    state::hash,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use url::Url;
use uuid::Uuid;

const DECISIONS: &[&str] = &["accept", "acceptForSession", "decline", "cancel"];
const PREFIX: &str = "<send_user_message_question_reply>\n";
const SUFFIX: &str = "\n</send_user_message_question_reply>";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub request_id: Uuid,
    pub target_request_id: String,
    pub expected_turn_id: Value,
    pub expected_fingerprint: String,
    decision: Option<String>,
    answers: Option<BTreeMap<String, Vec<String>>>,
    permission_ids: Option<Vec<String>>,
    scope: Option<String>,
    action: Option<String>,
    content: Option<Map<String, Value>>,
    plan_decision: Option<String>,
    feedback: Option<String>,
}

impl Response {
    pub(crate) fn dsh_value(&self, shown: &Value) -> Result<Value> {
        ensure!(
            shown["id"] == self.target_request_id
                && shown["turnId"] == self.expected_turn_id
                && shown["fingerprint"] == self.expected_fingerprint
                && shown["actionable"] == true,
            "DSH 请求已处理或内容已变化"
        );
        if shown["kind"] == "command" {
            return Ok(json!(match self.decision.as_deref() {
                Some("accept") => "allowed-once",
                Some("decline") => "rejected",
                Some("cancel") => "cancelled",
                _ => bail!("不支持此 DSH 审批选项"),
            }));
        }
        ensure!(
            matches!(shown["kind"].as_str(), Some("question" | "async-question")),
            "DSH 问题不可用"
        );
        let answers = self.checked_answers(shown)?;
        let questions = shown["questions"].as_array().context("DSH 问题不可用")?;
        let mut rows = Vec::with_capacity(answers.len());
        for ((id, values), question) in answers.into_iter().zip(questions) {
            ensure!(
                question["multiSelect"] == true || values.len() == 1,
                "此问题只接受一项回答"
            );
            let options = question["options"].as_array().context("DSH 问题选项无效")?;
            let (selected, custom): (Vec<_>, Vec<_>) = values.iter().partition(|value| {
                options
                    .iter()
                    .any(|option| option["label"].as_str() == Some(value.as_str()))
            });
            rows.push(json!({
                "id":id, "selected":selected,
                "custom":custom.into_iter().map(String::as_str).collect::<Vec<_>>().join("\n")
            }));
        }
        Ok(json!({"answers":rows}))
    }

    pub fn validate(&self) -> Result<()> {
        let forms = [
            self.decision.is_some(),
            self.answers.is_some(),
            self.permission_ids.is_some(),
            self.action.is_some(),
            self.plan_decision.is_some(),
        ];
        ensure!(
            forms.into_iter().filter(|active| *active).count() == 1
                && bounded(&self.target_request_id, 500)
                && (self.expected_turn_id.is_null()
                    || self
                        .expected_turn_id
                        .as_str()
                        .is_some_and(|id| bounded(id, 200)))
                && self.expected_fingerprint.len() == 64
                && self
                    .expected_fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "交互响应参数无效"
        );
        ensure!(
            self.scope.is_none()
                || (self.permission_ids.is_some()
                    && matches!(self.scope.as_deref(), Some("turn" | "session"))),
            "授权范围无效"
        );
        ensure!(
            self.feedback.is_none() || self.plan_decision.as_deref() == Some("revise"),
            "计划反馈参数无效"
        );
        ensure!(
            self.content.is_none() || self.action.as_deref() == Some("accept"),
            "表单响应无效"
        );
        Ok(())
    }

    pub fn native(&self, id: Uuid, view: &View) -> Result<(&'static str, u32, Value)> {
        let shown = view.thread["requests"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|request| request["id"] == self.target_request_id)
            .context("此请求已处理或过期")?;
        ensure!(
            shown["turnId"] == self.expected_turn_id
                && shown["fingerprint"] == self.expected_fingerprint
                && shown["actionable"] == true,
            "请求内容已变化，请重新核对"
        );
        if shown["kind"] == "async-question" {
            ensure!(
                view.thread["pendingRequests"] == 0,
                "桌面正在等待另一项交互"
            );
            let text = self.async_reply(shown)?;
            if view.thread["activeTurnId"].is_string() {
                return Ok((
                    "thread-follower-steer-turn",
                    1,
                    json!({
                        "conversationId":id,"input":text_input(&text),"attachments":[],
                        "clientUserMessageId":self.request_id,
                        "restoreMessage":{"id":self.request_id,"text":text,"cwd":view.thread["cwd"],"context":{"fileAttachments":[]}},
                    }),
                ));
            }
            ensure!(view.thread["canSend"] == true, "当前不能发送回答");
            return Ok(self.follow_up(id, &text, None));
        }
        let request = view
            .pending
            .iter()
            .find(|raw| request_id(raw).as_deref() == Some(&self.target_request_id))
            .context("此请求已处理或过期")?;
        let params = &request["params"];
        let mut body = json!({"conversationId":id,"requestId":request["id"]});
        let method = match request["method"].as_str() {
            Some("item/tool/requestUserInput") => {
                let answers = self.checked_answers(shown)?;
                body["response"] = json!({"answers": answers.into_iter().map(|(id, values)| (id.to_owned(), json!({"answers":values}))).collect::<Map<_,_>>()});
                "thread-follower-submit-user-input"
            }
            Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval") => {
                let decision = self.decision.as_deref().context("缺少审批决定")?;
                ensure!(
                    shown["decisions"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|item| item == decision)),
                    "当前审批不允许此选择"
                );
                body["decision"] = json!(decision);
                if shown["kind"] == "command" {
                    "thread-follower-command-approval-decision"
                } else {
                    "thread-follower-file-approval-decision"
                }
            }
            Some("item/permissions/requestApproval") => {
                let ids = self.permission_ids.as_deref().context("缺少权限选择")?;
                let choices = permission_options(&params["permissions"]);
                ensure!(
                    ids.len() <= 100
                        && ids
                            .iter()
                            .all(|id| choices.iter().any(|choice| &choice.id == id)),
                    "不能授予未请求的权限"
                );
                let mut permissions = json!({});
                for choice in choices
                    .into_iter()
                    .filter(|choice| ids.contains(&choice.id))
                {
                    if let Some(child) = choice.child {
                        let list = &mut permissions[choice.key][child];
                        if list.is_null() {
                            *list = json!([]);
                        }
                        list.as_array_mut().unwrap().push(choice.value);
                    } else {
                        permissions[choice.key] = choice.value;
                    }
                }
                body["response"] = json!({"permissions":permissions,"scope":self.scope.as_deref().unwrap_or("turn")});
                "thread-follower-permissions-request-approval-response"
            }
            Some("mcpServer/elicitation/request") => {
                let action = self
                    .action
                    .as_deref()
                    .filter(|value| matches!(*value, "accept" | "decline" | "cancel"))
                    .context("表单选择无效")?;
                let content = if action == "accept" && params["mode"] != "url" {
                    let content = json!(self.content.as_ref().context("缺少表单内容")?);
                    ensure!(content.to_string().len() <= 100_000, "表单内容过大");
                    let validator = jsonschema::options()
                        .should_validate_formats(true)
                        .build(&params["requestedSchema"])
                        .map_err(|_| anyhow::anyhow!("无法验证此表单，请在桌面完成"))?;
                    ensure!(validator.is_valid(&content), "表单内容与请求格式不符");
                    content
                } else {
                    ensure!(self.content.is_none(), "该操作不接受表单数据");
                    Value::Null
                };
                body["response"] = json!({"action":action,"content":content});
                "thread-follower-submit-mcp-server-elicitation-response"
            }
            Some("item/plan/requestImplementation") => {
                ensure!(
                    view.thread["activeTurnId"].is_null()
                        && view.thread["runtimeStatus"] == "idle"
                        && view.thread["model"].is_string()
                        && view.pending.len() == 1
                        && params["threadId"] == id.to_string()
                        && view
                            .turns
                            .last()
                            .is_some_and(|turn| params["turnId"] == turn.id),
                    "计划已变化或当前正在执行"
                );
                let (text, mode) = match self.plan_decision.as_deref() {
                    Some("implement") => (
                        format!(
                            "PLEASE IMPLEMENT THIS PLAN:\n{}",
                            params["planContent"].as_str().unwrap_or_default()
                        ),
                        "default",
                    ),
                    Some("revise") => (
                        self.feedback
                            .as_deref()
                            .map(str::trim)
                            .filter(|text| bounded(text, 16_000))
                            .context("请填写计划反馈")?
                            .to_owned(),
                        "plan",
                    ),
                    _ => bail!("计划响应无效"),
                };
                return Ok(self.follow_up(id, &text, Some(json!({"mode":mode,"settings":{
                    "model":view.thread["model"],"reasoning_effort":view.thread["reasoningEffort"],"developer_instructions":null,
                }}))));
            }
            _ => bail!("请在桌面处理此请求"),
        };
        Ok((method, 1, body))
    }

    fn follow_up(&self, id: Uuid, text: &str, mode: Option<Value>) -> (&'static str, u32, Value) {
        let mut request =
            json!({"threadId":id,"input":text_input(text),"clientUserMessageId":self.request_id});
        if let Some(mode) = mode {
            request["collaborationMode"] = mode;
        }
        (
            "thread-follower-start-turn",
            2,
            json!({"conversationId":id,
                "turnStart":{"request":request,"context":{"inheritThreadSettings":true,"attachments":[]}},
            }),
        )
    }

    fn checked_answers<'a>(&'a self, shown: &'a Value) -> Result<Vec<(&'a str, &'a Vec<String>)>> {
        let questions = shown["questions"].as_array().context("问题已过期")?;
        let answers = self.answers.as_ref().context("缺少回答")?;
        ensure!(
            answers.len() == questions.len() && !answers.is_empty(),
            "请回答所有当前问题"
        );
        questions
            .iter()
            .map(|question| {
                let id = question["id"].as_str().context("问题 ID 无效")?;
                let values = answers.get(id).context("缺少回答")?;
                ensure!(
                    (1..=20).contains(&values.len())
                        && values.iter().all(|value| bounded(value.trim(), 16_000)),
                    "回答格式无效"
                );
                Ok((id, values))
            })
            .collect()
    }

    fn async_reply(&self, shown: &Value) -> Result<String> {
        let answers = self.checked_answers(shown)?;
        ensure!(
            answers.iter().all(|(_, values)| values.len() == 1),
            "每个问题只接受一项回答"
        );
        let rows: Vec<_> = answers.into_iter().zip(shown["questions"].as_array().unwrap())
            .map(|((id, answer), question)| json!({"questionItemId":id,"question":question["question"],"answer":answer[0]}))
            .collect();
        Ok(format!("{PREFIX}{}{SUFFIX}", json!(rows)))
    }
}

fn text_input(text: &str) -> Value {
    json!([{"type":"text","text":text,"text_elements":[]}])
}

fn bounded(text: &str, limit: usize) -> bool {
    !text.is_empty() && text.encode_utf16().count() <= limit
}

pub fn pending(state: &Value) -> Vec<Value> {
    let rows = &state["requests"];
    let values: Vec<_> = match rows {
        Value::Array(items) => items.iter().collect(),
        Value::Object(items) => items.values().collect(),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter(|value| {
            value.is_object() && (value["completed"].is_null() || value["completed"] == false)
        })
        .cloned()
        .collect()
}

pub(crate) fn request_id(request: &Value) -> Option<String> {
    match &request["id"] {
        Value::String(id) if bounded(id, 500) => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

struct Permission {
    id: String,
    key: &'static str,
    child: Option<&'static str>,
    label: String,
    value: Value,
}

fn permission_options(permissions: &Value) -> Vec<Permission> {
    let mut choices = Vec::new();
    for key in ["network", "fileSystem"] {
        let value = &permissions[key];
        let Some(fields) = value.as_object() else {
            continue;
        };
        if key == "fileSystem"
            && fields
                .keys()
                .all(|key| matches!(key.as_str(), "read" | "write"))
        {
            for (child, verb) in [("read", "读取"), ("write", "写入")] {
                for (index, path) in value[child].as_array().into_iter().flatten().enumerate() {
                    if let Some(path) = path.as_str() {
                        choices.push(Permission {
                            id: format!("{key}.{child}.{index}"),
                            key,
                            child: Some(child),
                            label: format!("{verb} {path}"),
                            value: json!(path),
                        });
                    }
                }
            }
        } else {
            choices.push(Permission {
                id: key.to_owned(),
                key,
                child: None,
                label: if key == "network" {
                    "请求的网络访问权限"
                } else {
                    "请求的文件权限"
                }
                .into(),
                value: value.clone(),
            });
        }
    }
    choices
}

pub fn normalize(request: &Value, items: &[&Value]) -> Value {
    let p = &request["params"];
    let item = items
        .iter()
        .find(|item| p["itemId"].is_string() && item["id"] == p["itemId"]);
    let get = |field: &str| {
        p.get(field)
            .filter(|v| !v.is_null())
            .or_else(|| item.and_then(|item| item.get(field)))
    };
    let mut details: Vec<_> = [p["reason"].as_str(), p["message"].as_str()]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect();
    for (field, label) in [
        ("cwd", "工作目录"),
        ("networkApprovalContext", "网络请求"),
        ("additionalPermissions", "附加权限"),
        ("grantRoot", "授权目录"),
    ] {
        if let Some(value) = p.get(field).filter(|v| !v.is_null()) {
            details.push(format!(
                "{label} {}",
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
            ));
        }
    }
    let mut options = Map::new();
    let (kind, title, eligible) = match request["method"].as_str() {
        Some("item/commandExecution/requestApproval") => {
            let command = get("command").filter(|value| {
                value.as_str().is_some_and(|s| !s.trim().is_empty())
                    || value.as_array().is_some_and(|items| {
                        !items.is_empty() && items.iter().all(Value::is_string)
                    })
            });
            if let Some(command) = command {
                details.push(
                    command
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| command.to_string()),
                );
            }
            (
                "command",
                if p["networkApprovalContext"].is_object() {
                    "网络访问审批"
                } else {
                    "命令执行审批"
                },
                command.is_some() || p["networkApprovalContext"].is_object(),
            )
        }
        Some("item/fileChange/requestApproval") => {
            let changes: Vec<_> = get("changes").and_then(Value::as_array).into_iter().flatten()
                .filter(|entry| entry["path"].is_string() && entry["diff"].is_string())
                .map(|entry| json!({"path":entry["path"],"diff":entry["diff"],
                    "kind":entry["kind"]["type"].as_str().or_else(|| entry["kind"].as_str()).unwrap_or("update")}))
                .collect();
            let complete = !changes.is_empty()
                && get("changes").and_then(Value::as_array).map(Vec::len) == Some(changes.len())
                && json!(changes).to_string().len() <= 500_000;
            if complete {
                options.insert("changes".into(), json!(changes));
            }
            ("file", "文件修改审批", complete)
        }
        Some("item/permissions/requestApproval") => {
            let choices = permission_options(&p["permissions"]);
            let complete = (1..=100).contains(&choices.len());
            if complete {
                options.insert("permissionOptions".into(), json!(choices.into_iter().map(|choice| json!({
                    "id":choice.id,"label":choice.label,"details":choice.value.as_str().map(str::to_owned).unwrap_or_else(|| choice.value.to_string())
                })).collect::<Vec<_>>()));
            }
            ("permissions", "权限申请", complete)
        }
        Some("item/tool/requestUserInput") => {
            let questions: Vec<_> = p["questions"].as_array().into_iter().flatten().filter(|q| q["id"].is_string())
                .map(|q| json!({"id":q["id"],"header":q["header"].as_str().unwrap_or_default(),
                    "question":q["question"].as_str().unwrap_or_default(),"secret":q["isSecret"] == true,
                    "options":q["options"].as_array().into_iter().flatten().filter(|o| o["label"].is_string())
                        .map(|o| json!({"label":o["label"],"description":o["description"].as_str().unwrap_or_default()}))
                        .collect::<Vec<_>>()})).collect();
            let complete = (1..=20).contains(&questions.len())
                && p["questions"].as_array().map(Vec::len) == Some(questions.len());
            if complete {
                options.insert("questions".into(), json!(questions));
            }
            ("question", "Codex 需要你的回答", complete)
        }
        Some("mcpServer/elicitation/request") => {
            let form = matches!(p["mode"].as_str(), Some("form" | "openai/form"))
                && p["requestedSchema"].is_object()
                && p["requestedSchema"].to_string().len() <= 50_000;
            if form {
                options.insert(
                    "form".into(),
                    json!({"mode":p["mode"],"schema":p["requestedSchema"]}),
                );
            }
            let url = (p["mode"] == "url")
                .then(|| Url::parse(p["url"].as_str().unwrap_or_default()).ok())
                .flatten()
                .filter(|url| {
                    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
                });
            let eligible = form || url.is_some();
            if let Some(url) = url {
                options.insert("url".into(), json!(url.as_str()));
            }
            ("elicitation", "连接器需要确认", eligible)
        }
        Some("item/plan/requestImplementation") => {
            let plan = p["planContent"]
                .as_str()
                .filter(|value| !value.trim().is_empty());
            if let Some(plan) = plan {
                details.insert(0, plan.to_owned());
            }
            (
                "plan",
                "计划等待批准",
                plan.is_some() && p["turnId"].is_string(),
            )
        }
        _ => ("unsupported", "桌面交互请求", false),
    };
    if matches!(kind, "command" | "file") {
        let decisions: Vec<_> = DECISIONS
            .iter()
            .filter(|decision| {
                p["availableDecisions"]
                    .as_array()
                    .is_none_or(|items| items.iter().any(|value| value == **decision))
            })
            .collect();
        options.insert("decisions".into(), json!(decisions));
    }
    let mut description = details.join("\n");
    let mut complete = description.len() <= 100_000 && json!(options).to_string().len() <= 550_000;
    if !complete {
        description.truncate(description.floor_char_boundary(100_000));
        description.push_str("\n请在桌面核对完整请求。");
        options.clear();
    }
    let id = request_id(request);
    complete &= id.is_some() && (p["turnId"].is_null() || p["turnId"].is_string());
    options.extend([
        (
            "id".into(),
            json!(id.unwrap_or_else(|| format!("unsupported:{}", hash(&request.to_string())))),
        ),
        (
            "fingerprint".into(),
            json!(hash(
                &json!([request["id"], request["method"], p]).to_string()
            )),
        ),
        ("kind".into(), json!(kind)),
        ("title".into(), json!(title)),
        ("description".into(), json!(description)),
        ("turnId".into(), p["turnId"].clone()),
        ("actionable".into(), json!(complete && eligible)),
    ]);
    Value::Object(options)
}

fn replies(raw: &str) -> Vec<Value> {
    let Some(body) = raw
        .trim()
        .strip_prefix(PREFIX)
        .and_then(|raw| raw.strip_suffix(SUFFIX))
    else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(rows)) => rows,
        Ok(Value::Object(row)) => vec![Value::Object(row)],
        _ => Vec::new(),
    }
}

pub fn display_reply(text: String) -> String {
    let rows = replies(&text);
    if rows.is_empty() {
        text
    } else {
        rows.iter()
            .filter_map(|row| {
                Some(format!(
                    "{}\n{}",
                    row["question"].as_str()?,
                    row["answer"].as_str()?
                ))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

pub fn asynchronous(turns: &[&Value]) -> Vec<Value> {
    let mut pending = BTreeMap::new();
    let mut answered = HashSet::new();
    let mut record = |text: &str| {
        let replies = replies(text);
        for row in &replies {
            if let Some(id) = row["questionItemId"].as_str() {
                answered.insert(id.to_owned());
            }
        }
        !replies.is_empty()
    };
    for turn in turns {
        let Some(id) = turn["turnId"].as_str().or_else(|| turn["id"].as_str()) else {
            continue;
        };
        let items = ordered(&turn["items"]);
        let mut opening = native_text(&turn["params"]["input"]);
        if opening.is_empty()
            && let Some(item) = items.iter().find(|item| item["type"] == "userMessage")
        {
            opening = native_text(&item["content"]);
        }
        if !opening.trim().is_empty() && !record(&opening) {
            pending.clear();
        }
        for item in items {
            if item["type"] == "userMessage"
                || (item["type"] == "steeringUserMessage" && item["status"] == "accepted")
            {
                record(&native_text(
                    item.get("content")
                        .or_else(|| item.get("input"))
                        .unwrap_or(&item["text"]),
                ));
            }
            if item["type"] != "agentMessage" {
                continue;
            }
            let Some(item_id) = item["id"].as_str() else {
                continue;
            };
            let Some(rows) = item["questions"]
                .as_array()
                .filter(|rows| (1..=20).contains(&rows.len()))
            else {
                continue;
            };
            let questions: Vec<_> = rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| {
                    let title = row["title"].as_str().filter(|text| bounded(text, 16_000))?;
                    let options: Vec<_> = row["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|label| json!({"label":label,"description":""}))
                        .collect();
                    Some(
                        json!({"id":json!(["request_user_input_async",item_id,index]).to_string(),
                    "header":format!("问题 {}",index+1),"question":title,"options":options}),
                    )
                })
                .collect();
            if questions.len() == rows.len() {
                pending.insert(item_id, (id, questions));
            }
        }
    }
    pending.into_iter().filter_map(|(item, (turn, mut questions))| {
        questions.retain(|question| question["id"].as_str().is_some_and(|id| !answered.contains(id)));
        if questions.is_empty() || json!(questions).to_string().len() > 100_000 { return None; }
        Some(json!({"id":format!("async:{item}"),"turnId":turn,"kind":"async-question","title":"Codex 需要你的回答",
            "description":"","actionable":true,"questions":questions,"fingerprint":hash(&json!([turn,item,questions]).to_string())}))
    }).collect()
}
