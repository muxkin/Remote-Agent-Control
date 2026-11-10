use crate::{
    codex::History,
    codex_live::View,
    state::{hash, now},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    rows: Vec<Value>,
    fingerprint: String,
}

impl Snapshot {
    pub fn read(history: &History, thread: Uuid) -> Result<Self> {
        let rows = history.native_queue(thread)?;
        let fingerprint = hash(&serde_json::to_string(&rows)?);
        Ok(Self { rows, fingerprint })
    }

    pub fn display(&self, thread: &mut Value) {
        thread["queueFingerprint"] = json!(self.fingerprint);
        thread["queuedMessages"] = json!(self.rows.iter().take(30)
            .filter(|row| row["id"].is_string()).map(|row| json!({"id":row["id"],
                "text":row["text"].as_str().or_else(|| row["context"]["prompt"].as_str()).unwrap_or_default(),
                "status":row["submission"]["status"].as_str().unwrap_or("queued"),"reason":row["pausedReason"],
            })).collect::<Vec<_>>());
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub request_id: Uuid,
    expected_queue_fingerprint: String,
    text: Option<String>,
    message_id: Option<String>,
}

impl Change {
    pub fn validate(&mut self, adding: bool) -> Result<()> {
        ensure!(
            self.expected_queue_fingerprint.len() == 64
                && self
                    .expected_queue_fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "请重新加载队列"
        );
        if adding {
            ensure!(self.message_id.is_none(), "队列参数无效");
            let text = self
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| (1..=16_000).contains(&text.encode_utf16().count()))
                .context("请输入队列消息")?;
            self.text = Some(text.to_owned());
        } else {
            ensure!(
                self.text.is_none()
                    && self.message_id.as_ref().is_some_and(|id| {
                        (1..=200).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)
                    }),
                "队列消息 ID 无效"
            );
        }
        Ok(())
    }

    pub fn name(&self) -> &'static str {
        if self.text.is_some() {
            "queue"
        } else {
            "queue-remove"
        }
    }

    pub fn request(
        &self,
        id: Uuid,
        view: &View,
        state: &Value,
        queue: Snapshot,
    ) -> Result<(&'static str, u32, Value)> {
        ensure!(
            queue.fingerprint == self.expected_queue_fingerprint,
            "桌面队列已变化，请刷新后重试"
        );
        if let Some(text) = self.text.as_deref() {
            ensure!(
                !view.thread["activeTurnId"].is_null()
                    && view.pending.is_empty()
                    && queue.rows.len() < 30,
                "当前会话无法添加队列消息"
            );
            let cwd = &view.thread["cwd"];
            let roots = state["currentPermissions"]["runtimeWorkspaceRoots"]
                .as_array()
                .map_or_else(|| json!([cwd]), |roots| json!(roots));
            let mut rows = queue.rows;
            rows.push(json!({
                "id":self.request_id,"text":text,"cwd":cwd,"acceptedAtMs":now(),"requiresExistingOwner":true,
                "context":{"prompt":text,"fileAttachments":[],"addedFiles":[],"imageAttachments":[],"appshotContexts":[],
                    "mcpAppModelContextAttachments":[],"pastedTextAttachments":[],"uploadedFileAttachments":[],
                    "commentAttachments":[],"workspaceRoots":roots},
                "submissionOptions":{"usePermissionSelection":false,"shouldSendPermissionOverrides":false,
                    "collaborationMode":state["latestCollaborationMode"]},
                "submissionIntent":"queue","submission":{"hostId":"local","status":"queued","queueModeOverride":"queue-only"},
            }));
            Ok((
                "thread-follower-set-queued-follow-ups-state",
                1,
                json!({
                    "conversationId":id,"state":{id.to_string():rows},"discardedMessageIds":[],
                }),
            ))
        } else {
            let message_id = self.message_id.as_deref().context("队列消息 ID 无效")?;
            let row = queue
                .rows
                .iter()
                .find(|row| row["id"] == message_id)
                .context("消息已离开队列")?;
            ensure!(
                !matches!(
                    row["submission"]["status"].as_str(),
                    Some("sending" | "outcome-unknown")
                ),
                "消息已开始发送或结果待确认"
            );
            Ok((
                "thread-follower-remove-queued-message",
                1,
                json!({"conversationId":id,"messageId":message_id}),
            ))
        }
    }

    pub fn confirmed(&self, reply: &Value) -> bool {
        let key = if self.text.is_some() { "ok" } else { "removed" };
        reply["result"][key] == true
    }
}
