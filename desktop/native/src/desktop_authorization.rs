use crate::state::{Pairing, Store, hash, now};
use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use url::{Url, form_urlencoded::Serializer};
use uuid::Uuid;

pub(crate) struct AuthorizationLink {
    pairing: Pairing,
    state: Uuid,
    start: Url,
    completion: Option<Url>,
}

impl AuthorizationLink {
    pub(crate) fn open(
        pending: &mut Option<Self>,
        db: &mut Store,
        origin: &str,
        port: u16,
    ) -> Result<String> {
        if let Some(link) = pending.as_ref()
            && link.completion.is_some()
            && db.pairing_pending(&link.pairing)?
        {
            return Ok(link.start.to_string());
        }
        let name: String = ["COMPUTERNAME", "HOSTNAME"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Agent 空间电脑".into())
            .trim()
            .chars()
            .filter(|ch| !ch.is_control())
            .take(40)
            .collect();
        let name = if name.is_empty() {
            "Agent 空间电脑"
        } else {
            &name
        };
        let issued_at = now();
        let host = db.identity.public().to_peer_id().to_string();
        let pairing = db.mint_pairing(pending.as_ref().map(|link| &link.pairing))?;
        let ticket = hash(&pairing.code);
        let proof = format!(
            "codex-pocket/desktop-enrollment/1\n{origin}\n{host}\n{name}\n{ticket}\n{issued_at}"
        );
        let signature = STANDARD.encode(db.identity.sign(proof.as_bytes())?);
        let state = Uuid::new_v4();
        let state_text = state.to_string();
        let mut start = Url::parse(origin).context("无效的登录站点")?;
        start
            .query_pairs_mut()
            .append_pair("page", "desktop-authorization");
        let fragment = |extra: &[(&str, &str)]| {
            let mut serializer = Serializer::new(String::new());
            serializer
                .append_pair("host", &host)
                .append_pair("name", name)
                .append_pair("state", &state_text);
            serializer.extend_pairs(extra.iter().copied());
            serializer.finish()
        };
        let mut completion = start.clone();
        completion.set_fragment(Some(&fragment(&[
            ("issued", &issued_at.to_string()),
            ("signature", &signature),
            ("code", &pairing.code),
        ])));
        start.set_fragment(Some(&fragment(&[("port", &port.to_string())])));
        let result = start.to_string();
        *pending = Some(Self {
            pairing,
            state,
            start,
            completion: Some(completion),
        });
        Ok(result)
    }

    pub(crate) fn complete(&mut self, query: &str) -> Option<Url> {
        let state = query.strip_prefix("state=")?.parse::<Uuid>().ok()?;
        if state != self.state || self.pairing.expires_at <= now() {
            return None;
        }
        self.completion.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_the_pairing_code_only_once_on_loopback() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut db = Store::open(&directory.path().join("state"))?;
        let mut pending = None;
        let origin = "https://service.example";
        let start = AuthorizationLink::open(&mut pending, &mut db, origin, 12345)?;
        assert_eq!(
            start,
            AuthorizationLink::open(&mut pending, &mut db, origin, 12345)?
        );
        let start = Url::parse(&start)?;
        let params: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(start.fragment().unwrap().as_bytes()).collect();
        assert_eq!(params["port"], "12345");
        assert!(!params.contains_key("code"));
        assert!(!params.contains_key("signature"));

        let link = pending.as_mut().unwrap();
        assert!(
            link.complete(&format!("state={}", Uuid::new_v4()))
                .is_none()
        );
        let query = format!("state={}", params["state"]);
        let redirect = link.complete(&query).context("callback rejected")?;
        assert_eq!(redirect.origin().ascii_serialization(), origin);
        assert!(redirect.fragment().unwrap().contains("signature="));
        assert!(redirect.fragment().unwrap().contains("code="));
        assert!(link.complete(&query).is_none());
        Ok(())
    }
}
