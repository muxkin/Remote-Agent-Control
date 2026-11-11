use super::{Transport, block_length, decrypt};
use crate::{files::Scope, gateway::Database};
use anyhow::{Result, ensure};
use reqwest::{
    Response, StatusCode,
    header::{CONTENT_RANGE, RANGE},
};
use ring::aead::MAX_TAG_LEN;
use serde_json::Value;
use std::{collections::BTreeSet, ops::Range, time::Duration};
use uuid::Uuid;

impl Transport {
    pub(super) async fn receive_object(
        &self,
        db: &Database,
        device: &str,
        scope: &Scope,
        id: Uuid,
        key: &str,
        indices: Vec<usize>,
    ) -> Result<bool> {
        let state = db.lock().expect("database mutex poisoned").file_request(
            device,
            scope,
            id,
            "missing",
            None,
            &[],
        )?;
        let missing: BTreeSet<usize> = serde_json::from_value(state["missing"].clone())?;
        let manifest = state["manifest"].clone();
        let mut size = 0;
        let mut pending = Vec::new();
        for index in indices {
            let end = size + block_length(&manifest, index)? + MAX_TAG_LEN;
            if missing.contains(&index) {
                pending.push((index, size..end));
            }
            size = end;
        }
        if pending.is_empty() {
            return Ok(false);
        }

        let url = self.provider.download_url(key, 300).await?;
        for (position, (index, range)) in pending.iter().enumerate() {
            let interval = format!("{}-{}", range.start, range.end - 1);
            let response = self
                .http
                .get(url.clone())
                .header(RANGE, format!("bytes={interval}"))
                .timeout(Duration::from_secs(60))
                .send()
                .await?;
            let (bytes, blocks) = match response.status() {
                StatusCode::PARTIAL_CONTENT => {
                    let range_header = response
                        .headers()
                        .get(CONTENT_RANGE)
                        .and_then(|header| header.to_str().ok());
                    ensure!(
                        range_header
                            .is_some_and(|header| header == format!("bytes {interval}/{size}")
                                || header == format!("bytes {interval}/*")),
                        "对象返回的字节范围无效"
                    );
                    (
                        object_body(response, range.len()).await?,
                        vec![(*index, 0..range.len())],
                    )
                }
                StatusCode::OK => {
                    // Some providers ignore Range. Accept only a complete, size-checked object.
                    let bytes = object_body(response, size).await?;
                    write_blocks(
                        db,
                        device,
                        scope,
                        id,
                        manifest,
                        bytes,
                        pending[position..].to_vec(),
                    )
                    .await?;
                    return Ok(true);
                }
                _ => anyhow::bail!("对象读取失败"),
            };
            write_blocks(db, device, scope, id, manifest.clone(), bytes, blocks).await?;
        }
        Ok(true)
    }
}

async fn object_body(mut response: Response, size: usize) -> Result<Vec<u8>> {
    ensure!(
        response.content_length().is_none_or(|n| n == size as u64),
        "对象数据大小无效"
    );
    let mut bytes = Vec::with_capacity(size);
    while let Some(chunk) = response.chunk().await? {
        ensure!(chunk.len() <= size - bytes.len(), "对象数据过大");
        bytes.extend_from_slice(&chunk);
    }
    ensure!(bytes.len() == size, "对象数据未传完");
    Ok(bytes)
}

async fn write_blocks(
    db: &Database,
    device: &str,
    scope: &Scope,
    id: Uuid,
    manifest: Value,
    bytes: Vec<u8>,
    blocks: Vec<(usize, Range<usize>)>,
) -> Result<()> {
    let (db, device, scope) = (db.clone(), device.to_owned(), scope.clone());
    tokio::task::spawn_blocking(move || {
        for (index, range) in blocks {
            let plain = decrypt(&manifest, index, bytes[range].to_vec())?;
            db.lock().expect("database mutex poisoned").file_request(
                &device,
                &scope,
                id,
                "write",
                Some(index as u64),
                &plain,
            )?;
        }
        Ok(())
    })
    .await?
}
