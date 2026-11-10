use crate::{
    im_client::{Client, is_uid, required, segment},
    im_crypto::Envelope,
};
use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

const MAX_TIMESTAMP: u64 = (1 << 53) - 1;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    kind: Kind,
    recipient_id: String,
    title: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    questions: Option<Vec<Question>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Question,
    Approval,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Question {
    id: String,
    #[serde(default)]
    header: String,
    question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    multi_select: Option<bool>,
    #[serde(default)]
    options: Vec<Choice>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    label: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Response {
    Approval {
        decision: Decision,
        comment: Option<String>,
    },
    Question {
        answers: BTreeMap<String, Vec<String>>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Approve,
    Reject,
}

impl Input {
    pub(crate) fn normalize(mut self) -> Result<Self> {
        self.title = checked_trim(&self.title, 200)?;
        self.description = checked_trim(&self.description, 12_000)?;
        ensure!(
            is_uid(&self.recipient_id) && self.expires_at.is_none_or(valid_timestamp),
            "交互请求接收人或有效期无效"
        );
        match (&self.kind, &mut self.questions) {
            (Kind::Approval, None) => {}
            (Kind::Question, Some(questions)) if (1..=10).contains(&questions.len()) => {
                let mut ids = HashSet::new();
                for question in questions {
                    question.normalize()?;
                    ensure!(ids.insert(question.id.clone()), "问题 ID 不能重复");
                }
            }
            _ => anyhow::bail!("问题需要题目，授权不接受问题字段"),
        }
        Ok(self)
    }

    pub(crate) fn wire(&self) -> Value {
        let mut wire = json!({
            "kind": self.kind,
            "recipientId": self.recipient_id,
            "title": "加密请求",
            "description": "请使用支持加密的客户端读取",
        });
        if let Some(expires_at) = self.expires_at {
            wire["expiresAt"] = json!(expires_at);
        }
        if matches!(self.kind, Kind::Question) {
            wire["questions"] =
                json!([{"id":"encrypted","header":"","question":"加密问题","options":[]}]);
        }
        wire
    }

    fn response_status(&self, response: &Value) -> Result<&'static str> {
        match (
            self.kind,
            serde_json::from_value::<Response>(response.clone())?,
        ) {
            (Kind::Approval, Response::Approval { decision, comment }) => {
                ensure!(
                    comment.is_none_or(|text| text.encode_utf16().count() <= 120_000),
                    "审批说明过长"
                );
                Ok(match decision {
                    Decision::Approve => "approved",
                    Decision::Reject => "rejected",
                })
            }
            (Kind::Question, Response::Question { answers }) => {
                let questions = self.questions.as_ref().context("提问缺少问题")?;
                ensure!(
                    answers.len() == questions.len()
                        && questions.iter().all(|question| {
                            answers.get(&question.id).is_some_and(|values| {
                                let limit = if question.multi_select == Some(true) {
                                    12
                                } else {
                                    1
                                };
                                (1..=limit).contains(&values.len())
                                    && values.iter().all(|value| {
                                        !trim(value).is_empty()
                                            && value.encode_utf16().count() <= 120_000
                                    })
                            })
                        }),
                    "交互回复未完整回答"
                );
                Ok("answered")
            }
            _ => anyhow::bail!("交互回复与卡片类型不符"),
        }
    }
}

impl Question {
    fn normalize(&mut self) -> Result<()> {
        ensure!(
            (1..=80).contains(&self.id.len())
                && self
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                && !matches!(self.id.as_str(), "__proto__" | "constructor" | "prototype")
                && self.header.encode_utf16().count() <= 80
                && self
                    .detail
                    .as_ref()
                    .is_none_or(|detail| detail.encode_utf16().count() <= 8000)
                && self.options.len() <= 12,
            "问题字段无效"
        );
        self.question = checked_trim(&self.question, 2000)?;
        let mut labels = HashSet::new();
        for choice in &mut self.options {
            choice.label = checked_trim(&choice.label, 200)?;
            ensure!(
                choice.description.encode_utf16().count() <= 1000
                    && labels.insert(choice.label.clone()),
                "选项格式无效或重复"
            );
        }
        Ok(())
    }
}

impl Client {
    pub(crate) async fn decode_interaction(
        &self,
        cid: &str,
        message_id: &str,
        signed: &Value,
        wire: &Value,
    ) -> Result<Option<Value>> {
        if signed.is_null() {
            ensure!(wire.is_null(), "交互请求未经签名");
            return Ok(None);
        }
        let original = serde_json::from_value::<Input>(signed.clone())?.normalize()?;
        let wire_expiry = wire["expiresAt"]
            .as_u64()
            .filter(|value| valid_timestamp(*value));
        let card_id = required(wire, "id")?;
        ensure!(
            Uuid::parse_str(card_id).is_ok()
                && wire["kind"] == json!(original.kind)
                && wire["recipientId"] == original.recipient_id
                && wire_expiry.is_some()
                && original
                    .expires_at
                    .is_none_or(|value| wire_expiry == Some(value)),
            "交互请求不匹配"
        );
        let status = required(wire, "status")?;
        let mut verified = serde_json::to_value(&original)?;
        verified["id"] = json!(card_id);
        verified["expiresAt"] = json!(wire_expiry);
        verified["status"] = json!(status);
        match status {
            "approved" | "rejected" | "answered" => {
                let sender = &original.recipient_id;
                ensure!(wire["respondedBy"] == *sender, "交互回复来源不符");
                let encoded = match original.kind {
                    Kind::Approval => wire["response"]["comment"].as_str(),
                    Kind::Question => wire["response"]["answers"]["encrypted"][0].as_str(),
                }
                .context("交互回复缺少签名")?;
                let context = format!("response:{cid}:{message_id}:{card_id}");
                let response = self
                    .decrypt(sender, &context, Envelope::parse(encoded)?)
                    .await?;
                ensure!(
                    original.response_status(&response)? == status,
                    "交互回复状态不匹配"
                );
                verified["response"] = response;
                verified["respondedBy"] = json!(sender);
                if let Some(time) = wire["respondedAt"]
                    .as_u64()
                    .filter(|value| valid_timestamp(*value))
                {
                    verified["respondedAt"] = json!(time);
                }
            }
            "pending" | "cancelled" | "expired" => {
                ensure!(
                    wire["response"].is_null() && wire["respondedBy"].is_null(),
                    "交互回复状态不匹配"
                );
            }
            _ => anyhow::bail!("交互状态无效"),
        }
        Ok(Some(verified))
    }

    pub(crate) async fn cancel_interaction(&self, id: &str, message_id: &str) -> Result<Value> {
        let path = format!(
            "/conversations/{}/messages/{}/interaction/cancel",
            segment(id),
            segment(message_id)
        );
        let response = self.request(Method::POST, &path, None).await?;
        self.decode_message(&response["message"]).await
    }
}

fn checked_trim(value: &str, max: usize) -> Result<String> {
    let value = trim(value);
    ensure!(
        (1..=max).contains(&value.encode_utf16().count()),
        "交互文本长度无效"
    );
    Ok(value.to_owned())
}

fn trim(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
                | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

fn valid_timestamp(value: u64) -> bool {
    (1..=MAX_TIMESTAMP).contains(&value)
}

pub(crate) fn terminal(card: &Value) -> bool {
    matches!(
        card["status"].as_str(),
        Some("answered" | "approved" | "rejected" | "cancelled" | "expired")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_body_cannot_supply_an_approval_result() {
        let input = json!({
            "kind":"approval","recipientId":"1","title":"权限","description":"测试",
        });
        let mut forged = input.clone();
        forged["status"] = json!("approved");
        assert!(serde_json::from_value::<Input>(forged).is_err());
        let card = serde_json::from_value::<Input>(input)
            .unwrap()
            .normalize()
            .unwrap();
        assert!(
            card.response_status(&json!({"answers":{"unexpected":["yes"]}}))
                .is_err()
        );
        assert_eq!(
            card.response_status(&json!({"decision":"approve"}))
                .unwrap(),
            "approved"
        );
    }
}
