use crate::{
    im_crypto::{AccountCrypto, Envelope, canonical, same_public_keys},
    state::private_file,
};
use anyhow::{Context, Result, ensure};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client as Http, Method, header, redirect};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Read, path::Path, time::Duration};
use tokio::sync::Mutex;
use url::Url;

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
        let http = Http::builder()
            .default_headers(headers)
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            id: id.to_owned(),
            origin: origin.to_owned(),
            http,
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
        let mut request = self
            .http
            .request(method, format!("{}/api/im{path}", self.origin))
            .timeout(Duration::from_secs(limit));
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(body)?);
        }
        let mut response = request.send().await?;
        ensure!(
            response.status().is_success(),
            "独立 Agent 服务请求返回 {}",
            response.status()
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 64 * 1024 * 1024,
                "独立 Agent 服务响应过大"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
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
        let interaction = &message["interaction"];
        let signed = &content["options"]["interaction"];
        if signed.is_object() {
            ensure!(
                interaction.is_object()
                    && interaction["kind"] == signed["kind"]
                    && interaction["recipientId"] == signed["recipientId"],
                "交互请求不匹配"
            );
            let mut verified = interaction.clone();
            verified
                .as_object_mut()
                .expect("interaction object")
                .extend(signed.as_object().expect("signed interaction").clone());
            if matches!(
                interaction["status"].as_str(),
                Some("approved" | "rejected" | "answered")
            ) {
                let sender = required(interaction, "recipientId")?;
                ensure!(interaction["respondedBy"] == sender, "交互回复来源不符");
                let reply = &interaction["response"];
                let encoded = reply["comment"]
                    .as_str()
                    .or_else(|| reply["answers"]["encrypted"][0].as_str())
                    .context("交互回复缺少签名")?;
                let context = format!("response:{cid}:{id}:{}", required(interaction, "id")?);
                let response = self
                    .decrypt(sender, &context, Envelope::parse(encoded)?)
                    .await?;
                let status = match response["decision"].as_str() {
                    Some("approve") => "approved",
                    Some("reject") => "rejected",
                    None if response["answers"].is_object() => "answered",
                    _ => anyhow::bail!("交互回复格式无效"),
                };
                ensure!(interaction["status"] == status, "交互回复状态不匹配");
                verified["response"] = response;
            }
            message["interaction"] = verified;
        } else {
            ensure!(interaction.is_null(), "交互请求未经签名");
        }
        let cid = required(&message, "conversationId")?.to_owned();
        if let Some(files) = message["attachments"].as_array_mut() {
            for file in files {
                if let Some(encrypted) = file["encrypted"].as_str() {
                    let context = format!("attachment:{cid}:{}", required(file, "id")?);
                    let envelope = Envelope::parse(encrypted)?;
                    let sender = envelope.sender().to_owned();
                    let metadata = self.decrypt(&sender, &context, envelope).await?;
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

    pub(crate) async fn send_text(&self, id: &str, client_id: &str, text: &str) -> Result<()> {
        ensure!(
            !text.trim().is_empty() && text.encode_utf16().count() <= 64_000,
            "消息长度无效"
        );
        let endpoint = format!("/conversations/{}", segment(id));
        let request = json!({"text":text,"options":{}});
        let previous = self
            .get(&format!("{endpoint}/by-client/{}", segment(client_id)))
            .await?;
        if !previous["message"].is_null() {
            let content = self.message_content(&previous["message"]).await?;
            ensure!(
                canonical(&content["request"]) == canonical(&request),
                "消息请求标识已用于其他内容"
            );
            return Ok(());
        }
        let snapshot = self.get(&endpoint).await?;
        let members = snapshot["conversation"]["members"]
            .as_array()
            .context("缺少会话成员")?;
        let recipients = members
            .iter()
            .map(|member| required(member, "id"))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            recipients.contains(&self.id.as_str()),
            "独立 Agent 不在此会话"
        );
        let content = json!({"text":text,"options":{},"state":"complete","request":request});
        let encrypted = self
            .encrypt(
                &recipients,
                &format!("message:{id}:{client_id}:0"),
                &content,
            )
            .await?;
        self.request(
            Method::POST,
            &format!("{endpoint}/messages"),
            Some(&json!({"text":encrypted,"clientId":client_id})),
        )
        .await?;
        Ok(())
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

fn is_uid(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('0') && id.bytes().all(|c| c.is_ascii_digit())
}

pub(crate) fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .context("独立 Agent 协议字段无效")
}

fn segment(id: &str) -> String {
    utf8_percent_encode(id, NON_ALPHANUMERIC).to_string()
}
