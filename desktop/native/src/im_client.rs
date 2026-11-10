use crate::{
    im_crypto::{AccountCrypto, Envelope, canonical, same_public_keys},
    im_interactions::Input as InteractionInput,
    state::private_file,
};
use anyhow::{Context, Result, ensure};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client as Http, Method, RequestBuilder, header, redirect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Read, path::Path, time::Duration};
use tokio::sync::Mutex;
use url::Url;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MessageState {
    #[default]
    Streaming,
    Complete,
    Failed,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<MessageState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mentions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interaction: Option<InteractionInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NewMessage {
    pub(crate) client_id: String,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) options: SendOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageUpdate {
    pub(crate) message_id: String,
    revision: u32,
    text: String,
    #[serde(default)]
    state: MessageState,
    activities: Option<Vec<Activity>>,
}

#[derive(Deserialize, Serialize)]
struct Activity {
    kind: ActivityKind,
    status: ActivityStatus,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ActivityKind {
    Read,
    Search,
    Fetch,
    Execute,
    Edit,
    Other,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ActivityStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug)]
pub(crate) struct MessageConflict;

impl std::fmt::Display for MessageConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("消息请求标识已用于其他内容，或回复版本已变化")
    }
}

impl std::error::Error for MessageConflict {}

pub(crate) struct Client {
    pub(crate) id: String,
    pub(crate) origin: String,
    http: Http,
    keys: AccountCrypto,
    pins: Mutex<BTreeMap<String, Value>>,
}

impl Client {
    pub(crate) fn load(state: &Path) -> Result<Self> {
        let file = private_file(state, false)?;
        let credentials: Value =
            serde_json::from_reader(file.take(256 * 1024)).context("独立 Agent 凭据文件无效")?;
        let id = credentials["user"]["id"]
            .as_str()
            .filter(|id| is_uid(id))
            .context("独立 Agent 身份无效")?;
        ensure!(
            credentials["user"]["kind"] == "agent",
            "需要独立 Agent 账号"
        );
        let origin = credentials["origin"]
            .as_str()
            .context("缺少独立 Agent 服务地址")?;
        let url = Url::parse(origin)?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure!(
            (url.scheme() == "https" || (url.scheme() == "http" && loopback))
                && url.origin().ascii_serialization() == origin,
            "独立 Agent 服务地址无效"
        );
        let token = credentials["token"]
            .as_str()
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_graphic()))
            .context("独立 Agent 凭据无效")?;
        let mut bearer = header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        bearer.set_sensitive(true);
        let mut headers = header::HeaderMap::new();
        headers.insert(header::AUTHORIZATION, bearer);
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        let mut http = Http::builder()
            .default_headers(headers)
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10));
        if loopback {
            http = http.no_proxy();
        }
        Ok(Self {
            id: id.to_owned(),
            origin: origin.to_owned(),
            http: http.build()?,
            keys: AccountCrypto::from_secrets(&credentials["secrets"])?,
            pins: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) async fn get(&self, path: &str) -> Result<Value> {
        self.request(Method::GET, path, None).await
    }

    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let limit = if path.starts_with("/sync?") { 35 } else { 15 };
        let mut request = self.api_request(method, path, limit);
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(body)?);
        }
        Ok(serde_json::from_slice(
            &checked_bytes(request, 64 * 1024 * 1024).await?,
        )?)
    }

    pub(crate) fn api_request(&self, method: Method, path: &str, seconds: u64) -> RequestBuilder {
        self.http
            .request(method, format!("{}/api/im{path}", self.origin))
            .timeout(Duration::from_secs(seconds))
    }

    pub(crate) async fn verify(&self) -> Result<()> {
        let response = self.get("/me").await?;
        ensure!(
            response["user"]["id"] == self.id && response["user"]["kind"] == "agent",
            "独立 Agent 凭据与账号不匹配"
        );
        Ok(())
    }

    async fn stored_pin(&self, id: &str, context: &str) -> Result<(u64, Option<Value>)> {
        let response = self
            .get(&format!("/crypto/items?accountId={}", self.id))
            .await?;
        let items = response["items"]
            .as_array()
            .context("独立 Agent 密钥记录无效")?;
        let Some(item) = items.iter().find(|item| item["id"] == id) else {
            return Ok((0, None));
        };
        let revision = item["revision"]
            .as_u64()
            .context("联系人密钥记录版本无效")?;
        let pinned = (!item["ciphertext"].is_null())
            .then(|| self.keys.open_record(context, &item["ciphertext"]))
            .transpose()?;
        Ok((revision, pinned))
    }

    pub(crate) async fn public_keys(&self, id: &str) -> Result<Value> {
        ensure!(is_uid(id), "独立 Agent 联系人身份无效");
        if id == self.id {
            return Ok(self.keys.public.clone());
        }
        let mut pins = self.pins.lock().await;
        if let Some(keys) = pins.get(id) {
            return Ok(keys.clone());
        }
        let response = self.get(&format!("/crypto/keys/{id}")).await?;
        let keys = &response["publicKeys"];
        let item = self.keys.private_id(&format!("contact-key:{id}"))?;
        let context = format!("vault:{}:{item}", self.id);
        let (revision, pinned) = self.stored_pin(&item, &context).await?;
        if let Some(pinned) = pinned {
            ensure!(same_public_keys(&pinned, keys)?, "联系人加密身份已变化");
        } else {
            same_public_keys(keys, keys)?;
            let record = json!({
                "accountId":self.id,"revision":revision,
                "ciphertext":self.keys.seal_record(&context, keys)?
            });
            if self
                .request(Method::PUT, &format!("/crypto/items/{item}"), Some(&record))
                .await
                .is_err()
            {
                let (_, pinned) = self.stored_pin(&item, &context).await?;
                ensure!(
                    pinned
                        .as_ref()
                        .is_some_and(|pin| same_public_keys(pin, keys).unwrap_or(false)),
                    "无法保存联系人加密身份"
                );
            }
        }
        pins.insert(id.to_owned(), keys.clone());
        Ok(keys.clone())
    }

    pub(crate) async fn encrypt(
        &self,
        recipients: &[&str],
        context: &str,
        value: &Value,
    ) -> Result<String> {
        let mut keys = BTreeMap::new();
        for &id in recipients {
            keys.insert(id.to_owned(), self.public_keys(id).await?);
        }
        self.keys.encrypt(&self.id, &keys, context, value)
    }

    pub(crate) async fn decrypt(
        &self,
        sender: &str,
        context: &str,
        envelope: Envelope,
    ) -> Result<Value> {
        let keys = self.public_keys(sender).await?;
        self.keys
            .decrypt(&self.id, sender, &keys, context, envelope)
    }

    async fn message_content(&self, message: &Value) -> Result<Value> {
        let prefix = format!(
            "message:{}:{}:",
            required(message, "conversationId")?,
            required(message, "clientId")?,
        );
        let envelope = Envelope::parse(required(message, "text")?)?;
        let revision = envelope
            .context()
            .strip_prefix(&prefix)
            .and_then(|value| value.parse::<u64>().ok())
            .context("消息版本无效")?;
        ensure!(
            revision <= message["revision"].as_u64().context("消息版本无效")?,
            "消息版本不匹配"
        );
        let content = self
            .decrypt(
                required(message, "senderId")?,
                &format!("{prefix}{revision}"),
                envelope,
            )
            .await?;
        ensure!(
            content["text"].is_string()
                && content["options"].is_object()
                && content["options"]["replyTo"] == message["replyTo"]
                && attachment_ids(&content["options"]["attachmentIds"], false)?
                    == attachment_ids(&message["attachments"], true)?,
            "消息引用不匹配"
        );
        Ok(content)
    }

    pub(crate) async fn decode_message(&self, message: &Value) -> Result<Value> {
        let mut content = self.message_content(message).await?;
        let mut message = message.clone();
        let cid = required(&message, "conversationId")?;
        let id = required(&message, "id")?;
        if let Some(verified) = self
            .decode_interaction(
                cid,
                id,
                &content["options"]["interaction"],
                &message["interaction"],
            )
            .await?
        {
            message["interaction"] = verified;
        }
        let cid = required(&message, "conversationId")?.to_owned();
        if let Some(files) = message["attachments"].as_array_mut() {
            for file in files {
                if let Some(encrypted) = file["encrypted"].as_str() {
                    let context = format!("attachment:{cid}:{}", required(file, "id")?);
                    let (_, metadata) = self.attachment_metadata(encrypted, &context).await?;
                    file["name"] = metadata["name"].clone();
                    file["mime"] = metadata["mime"].clone();
                    file["size"] = metadata["size"].clone();
                }
            }
        }
        message["text"] = content["text"].take();
        message["initialRequest"] = content["request"].take();
        message["sticker"] = json!(content["options"]["encryptedSticker"] == true);
        if message["sender"]["kind"] == "agent" {
            message["activities"] = content["activities"].take();
        }
        Ok(message)
    }

    pub(crate) async fn recipients(&self, endpoint: &str) -> Result<Vec<String>> {
        let snapshot = self.get(endpoint).await?;
        let recipients = snapshot["conversation"]["members"]
            .as_array()
            .context("缺少会话成员")?
            .iter()
            .map(|member| Ok(required(member, "id")?.to_owned()))
            .collect::<Result<Vec<_>>>()?;
        ensure!(recipients.contains(&self.id), "独立 Agent 不在此会话");
        Ok(recipients)
    }

    async fn seal_message(
        &self,
        id: &str,
        endpoint: &str,
        client_id: &str,
        revision: u32,
        content: &Value,
    ) -> Result<String> {
        let recipients = self.recipients(endpoint).await?;
        let recipients: Vec<_> = recipients.iter().map(String::as_str).collect();
        self.encrypt(
            &recipients,
            &format!("message:{id}:{client_id}:{revision}"),
            content,
        )
        .await
    }

    pub(crate) async fn send(&self, id: &str, input: &NewMessage) -> Result<Value> {
        let NewMessage {
            client_id,
            text,
            options,
        } = input;
        let state = options.state.unwrap_or(MessageState::Complete);
        let has_attachments = options
            .attachment_ids
            .as_ref()
            .is_some_and(|ids| !ids.is_empty());
        ensure!(
            (1..=128).contains(&client_id.encode_utf16().count())
                && text.encode_utf16().count() <= 64_000
                && !matches!(state, MessageState::Failed)
                && (matches!(state, MessageState::Streaming)
                    || !text.trim().is_empty()
                    || has_attachments
                    || options.interaction.is_some()),
            "消息格式无效"
        );
        let mut original = serde_json::to_value(options)?;
        let card = options
            .interaction
            .clone()
            .map(InteractionInput::normalize)
            .transpose()?;
        if let Some(card) = &card {
            ensure!(
                matches!(state, MessageState::Complete) && !has_attachments,
                "交互卡片不能包含流式回复或附件"
            );
            original["interaction"] = serde_json::to_value(card)?;
        }
        let endpoint = format!("/conversations/{}", segment(id));
        let request = json!({"text":text,"options":original});
        let previous = self
            .get(&format!("{endpoint}/by-client/{}", segment(client_id)))
            .await?;
        if !previous["message"].is_null() {
            let message = self.decode_message(&previous["message"]).await?;
            if canonical(&message["initialRequest"]) != canonical(&request) {
                return Err(MessageConflict.into());
            }
            return Ok(message);
        }
        let content = json!({"text":text,"options":original,"state":state,"request":request});
        let encrypted = self
            .seal_message(id, &endpoint, client_id, 0, &content)
            .await?;
        let mut body = original;
        if let Some(card) = card {
            body["interaction"] = card.wire();
        }
        body["text"] = json!(encrypted);
        body["clientId"] = json!(client_id);
        let response = self
            .request(Method::POST, &format!("{endpoint}/messages"), Some(&body))
            .await?;
        self.decode_message(&response["message"]).await
    }

    pub(crate) async fn update(&self, id: &str, input: &MessageUpdate) -> Result<Value> {
        let MessageUpdate {
            message_id,
            revision,
            text,
            state,
            activities,
        } = input;
        ensure!(
            (1..=1_000_000).contains(revision)
                && text.encode_utf16().count() <= 64_000
                && activities.as_ref().is_none_or(|items| items.len() <= 8),
            "流式回复格式无效"
        );
        let endpoint = format!("/conversations/{}", segment(id));
        let path = format!("{endpoint}/messages/{}", segment(message_id));
        let response = self.get(&path).await?;
        let message = &response["message"];
        ensure!(message["senderId"] == self.id, "只能更新自己发出的回复");
        let previous = self.message_content(message).await?;
        let mut content = previous.clone();
        content["text"] = json!(text);
        content["state"] = json!(state);
        if let Some(activities) = activities {
            content["activities"] = json!(activities);
        }
        let current = message["revision"].as_u64().context("消息版本无效")?;
        if u64::from(*revision) == current {
            if message["state"] == content["state"] && content == previous {
                return self.decode_message(message).await;
            }
            return Err(MessageConflict.into());
        }
        if message["state"] != "streaming" || u64::from(*revision) != current + 1 {
            return Err(MessageConflict.into());
        }
        let client_id = required(message, "clientId")?;
        let encrypted = self
            .seal_message(id, &endpoint, client_id, *revision, &content)
            .await?;
        let response = self
            .request(
                Method::PATCH,
                &path,
                Some(&json!({
                    "text":encrypted,"revision":revision,"state":state
                })),
            )
            .await?;
        self.decode_message(&response["message"]).await
    }

    pub(crate) async fn read_message(&self, id: &str, message_id: &str) -> Result<Value> {
        let path = format!(
            "/conversations/{}/messages/{}",
            segment(id),
            segment(message_id)
        );
        let response = self.get(&path).await?;
        Ok(self.decode_or_redact(&response["message"]).await)
    }

    pub(crate) async fn history(&self, id: &str, before: Option<u64>) -> Result<Value> {
        let mut path = format!("/conversations/{}/messages", segment(id));
        if let Some(before) = before {
            path.push_str(&format!("?before={before}"));
        }
        let mut result = self.get(&path).await?;
        let messages = result["messages"].as_array_mut().context("消息记录无效")?;
        for message in messages {
            *message = self.decode_or_redact(message).await;
        }
        Ok(result)
    }

    pub(crate) async fn cancel(&self, id: &str, message_id: &str) -> Result<Value> {
        let path = format!(
            "/conversations/{}/messages/{}/cancel",
            segment(id),
            segment(message_id)
        );
        let response = self.request(Method::POST, &path, None).await?;
        self.decode_message(&response["message"]).await
    }

    pub(crate) async fn decode_or_redact(&self, message: &Value) -> Value {
        self.decode_message(message).await.unwrap_or_else(|_| {
            let mut safe = message.clone();
            safe["text"] = json!("此消息无法解密或验证；请检查账号及联系人安全码");
            safe["attachments"] = json!([]);
            if let Some(fields) = safe.as_object_mut() {
                for key in ["interaction", "activities", "initialRequest", "sticker"] {
                    fields.remove(key);
                }
            }
            safe
        })
    }
}

fn attachment_ids(value: &Value, objects: bool) -> Result<Vec<&str>> {
    let mut ids = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            ids.push(if objects {
                required(item, "id")?
            } else {
                item.as_str().context("附件标识无效")?
            });
        }
    } else {
        ensure!(value.is_null(), "附件列表无效");
    }
    ids.sort_unstable();
    Ok(ids)
}

pub(crate) fn is_uid(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('0') && id.bytes().all(|c| c.is_ascii_digit())
}

pub(crate) fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .context("独立 Agent 协议字段无效")
}

pub(crate) fn segment(id: &str) -> String {
    utf8_percent_encode(id, NON_ALPHANUMERIC).to_string()
}

pub(crate) async fn checked_bytes(request: RequestBuilder, limit: usize) -> Result<Vec<u8>> {
    let mut response = request
        .send()
        .await
        .map_err(reqwest::Error::without_url)?
        .error_for_status()
        .map_err(reqwest::Error::without_url)?;
    ensure!(response.status().is_success(), "独立 Agent 服务重定向");
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        ensure!(
            chunk.len() <= limit - bytes.len(),
            "独立 Agent 服务响应过大"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
