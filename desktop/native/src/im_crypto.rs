use anyhow::{Context, Result, anyhow, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use p256::{PublicKey, SecretKey, ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint};
use ring::{
    aead, hkdf, hmac,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const SEALED: &str = "pocket-e2ee:1:";

pub(crate) struct AccountCrypto {
    root: [u8; 32],
    encryption: SecretKey,
    signing: signature::EcdsaKeyPair,
    pub(crate) public: Value,
}

pub(crate) struct Envelope(Value);

impl Envelope {
    pub(crate) fn parse(text: &str) -> Result<Self> {
        let encoded = text.strip_prefix(SEALED).context("消息未经加密")?;
        let value: Value = serde_json::from_slice(&STANDARD.decode(encoded)?)?;
        ensure!(
            value["version"] == 1
                && value["sender"].is_string()
                && value["context"].is_string()
                && value["recipients"].is_object()
                && value["body"].is_object()
                && value["signature"].as_str().is_some_and(|s| !s.is_empty())
                && value["operation"].as_str().is_some_and(|s| !s.is_empty()),
            "加密消息格式无效"
        );
        Ok(Self(value))
    }

    pub(crate) fn context(&self) -> &str {
        self.0["context"].as_str().expect("validated context")
    }

    pub(crate) fn sender(&self) -> &str {
        self.0["sender"].as_str().expect("validated sender")
    }

    pub(crate) fn recipients(&self) -> &Map<String, Value> {
        self.0["recipients"]
            .as_object()
            .expect("validated recipients")
    }
}

impl AccountCrypto {
    pub(crate) fn from_secrets(value: &Value) -> Result<Self> {
        let public = &value["publicKeys"];
        let encryption = SecretKey::from_slice(&private_scalar(&value["encryption"])?)
            .map_err(|_| anyhow!("Agent 加密密钥无效"))?;
        ensure!(
            encryption.public_key().to_encoded_point(false).as_bytes()
                == public_point(&public["encryption"])?,
            "Agent 加密公钥与私钥不匹配"
        );
        let signing = signature::EcdsaKeyPair::from_private_key_and_public_key(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &private_scalar(&value["signing"])?,
            &public_point(&public["signing"])?,
            &SystemRandom::new(),
        )
        .map_err(|_| anyhow!("Agent 签名公钥与私钥不匹配"))?;
        Ok(Self {
            root: decode_fixed(&STANDARD, &value["root"])?,
            encryption,
            signing,
            public: public.clone(),
        })
    }

    pub(crate) fn encrypt(
        &self,
        sender: &str,
        recipients: &BTreeMap<String, Value>,
        context: &str,
        value: &Value,
    ) -> Result<String> {
        let ephemeral = loop {
            if let Ok(secret) = SecretKey::from_slice(&random::<32>()?) {
                break secret;
            }
        };
        let point = ephemeral.public_key().to_encoded_point(false);
        let content_key = random::<32>()?;
        let plaintext = canonical(value);
        let wrapped = recipients
            .iter()
            .map(|(id, keys)| {
                let key =
                    wrapping_key(&ephemeral, &keys["encryption"], &format!("{context}:{id}"))?;
                Ok((
                    id.clone(),
                    seal(&key, &content_key, &format!("{context}:{sender}:{id}"))?,
                ))
            })
            .collect::<Result<Map<_, _>>>()?;
        let mut envelope = json!({
            "version":1,"sender":sender,"context":context,
            "operation":self.private_id(&format!("{context}:{plaintext}"))?,
            "ephemeral":{
                "kty":"EC","crv":"P-256","ext":true,"key_ops":[],
                "x":URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x")),
                "y":URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y")),
            },
            "recipients":wrapped,
            "body":seal(&content_key, plaintext.as_bytes(), &format!("{context}:{sender}"))?,
            "signature":"",
        });
        let signature = self
            .signing
            .sign(&SystemRandom::new(), canonical(&envelope).as_bytes())
            .map_err(|_| anyhow!("无法签署 Agent 消息"))?;
        envelope["signature"] = json!(STANDARD.encode(signature.as_ref()));
        Ok(format!("{SEALED}{}", STANDARD.encode(canonical(&envelope))))
    }

    pub(crate) fn decrypt(
        &self,
        recipient: &str,
        sender: &str,
        keys: &Value,
        context: &str,
        mut envelope: Envelope,
    ) -> Result<Value> {
        ensure!(
            envelope.0["sender"] == sender && envelope.context() == context,
            "消息身份或上下文不匹配"
        );
        let signed = envelope.0["signature"].take();
        envelope.0["signature"] = json!("");
        let verifier = signature::UnparsedPublicKey::new(
            &signature::ECDSA_P256_SHA256_FIXED,
            public_point(&keys["signing"])?,
        );
        verifier
            .verify(
                canonical(&envelope.0).as_bytes(),
                &STANDARD.decode(signed.as_str().context("消息签名格式无效")?)?,
            )
            .map_err(|_| anyhow!("消息签名无效"))?;
        let wrapped = envelope
            .recipients()
            .get(recipient)
            .context("此账号无权解密消息")?;
        let key = wrapping_key(
            &self.encryption,
            &envelope.0["ephemeral"],
            &format!("{context}:{recipient}"),
        )?;
        let content = open(&key, wrapped, &format!("{context}:{sender}:{recipient}"))?;
        let content = content
            .try_into()
            .map_err(|_| anyhow!("消息密钥长度无效"))?;
        let bytes = open(
            &content,
            &envelope.0["body"],
            &format!("{context}:{sender}"),
        )?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub(crate) fn private_id(&self, value: &str) -> Result<String> {
        let key = hmac::Key::new(hmac::HMAC_SHA256, &derive(&self.root, "identifiers")?);
        Ok(URL_SAFE_NO_PAD.encode(hmac::sign(&key, value.as_bytes()).as_ref()))
    }

    pub(crate) fn seal_record(&self, context: &str, value: &Value) -> Result<Value> {
        seal(
            &derive(&self.root, "private-records")?,
            canonical(value).as_bytes(),
            context,
        )
    }

    pub(crate) fn open_record(&self, context: &str, value: &Value) -> Result<Value> {
        let bytes = open(&derive(&self.root, "private-records")?, value, context)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

pub(crate) fn same_public_keys(a: &Value, b: &Value) -> Result<bool> {
    Ok(
        public_point(&a["encryption"])? == public_point(&b["encryption"])?
            && public_point(&a["signing"])? == public_point(&b["signing"])?,
    )
}

pub(crate) fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            let pairs = entries
                .into_iter()
                .map(|(key, value)| format!("{}:{}", json!(key), canonical(value)))
                .collect::<Vec<_>>();
            format!("{{{}}}", pairs.join(","))
        }
        _ => value.to_string(),
    }
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow!("无法获取加密随机数"))?;
    Ok(bytes)
}

fn decode_fixed<const N: usize>(engine: &impl Engine, value: &Value) -> Result<[u8; N]> {
    engine
        .decode(value.as_str().context("密钥或加密数据格式无效")?)?
        .try_into()
        .map_err(|_| anyhow!("密钥或加密数据长度无效"))
}

fn private_scalar(jwk: &Value) -> Result<[u8; 32]> {
    ensure!(
        jwk["kty"] == "EC" && jwk["crv"] == "P-256",
        "Agent 私钥格式无效"
    );
    decode_fixed(&URL_SAFE_NO_PAD, &jwk["d"])
}

fn public_point(jwk: &Value) -> Result<[u8; 65]> {
    ensure!(
        jwk["kty"] == "EC" && jwk["crv"] == "P-256" && jwk.get("d").is_none(),
        "公钥格式无效"
    );
    let mut point = [4; 65];
    point[1..33].copy_from_slice(&decode_fixed::<32>(&URL_SAFE_NO_PAD, &jwk["x"])?);
    point[33..].copy_from_slice(&decode_fixed::<32>(&URL_SAFE_NO_PAD, &jwk["y"])?);
    Ok(point)
}

fn wrapping_key(private: &SecretKey, public: &Value, context: &str) -> Result<[u8; 32]> {
    let public = PublicKey::from_sec1_bytes(&public_point(public)?)
        .map_err(|_| anyhow!("无效的 P-256 公钥"))?;
    let shared = diffie_hellman(private.to_nonzero_scalar(), public.as_affine());
    derive(
        shared.raw_secret_bytes(),
        &format!("message-wrapping:{context}"),
    )
}

fn derive(secret: &[u8], purpose: &str) -> Result<[u8; 32]> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[0; 32]);
    let prk = salt.extract(secret);
    let info = format!("pocket-account-v1:{purpose}");
    let parts = [info.as_bytes()];
    let okm = prk
        .expand(&parts, &aead::AES_256_GCM)
        .map_err(|_| anyhow!("密钥派生失败"))?;
    let mut bytes = [0; 32];
    okm.fill(&mut bytes).map_err(|_| anyhow!("密钥派生失败"))?;
    Ok(bytes)
}

fn cipher(key: &[u8; 32]) -> Result<aead::LessSafeKey> {
    let key =
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| anyhow!("消息密钥无效"))?;
    Ok(aead::LessSafeKey::new(key))
}

fn seal(key: &[u8; 32], data: &[u8], context: &str) -> Result<Value> {
    let iv = random::<12>()?;
    let mut bytes = data.to_vec();
    cipher(key)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(context.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| anyhow!("无法加密消息"))?;
    Ok(json!({"iv":STANDARD.encode(iv),"data":STANDARD.encode(bytes)}))
}

fn open(key: &[u8; 32], value: &Value, context: &str) -> Result<Vec<u8>> {
    let iv = decode_fixed(&STANDARD, &value["iv"])?;
    let mut bytes = STANDARD.decode(value["data"].as_str().context("加密数据格式无效")?)?;
    let plaintext = cipher(key)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(context.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| anyhow!("加密数据校验失败"))?;
    let len = plaintext.len();
    bytes.truncate(len);
    Ok(bytes)
}
