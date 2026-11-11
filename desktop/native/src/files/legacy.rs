use super::*;
use crate::history_media::{LegacyUpload, MissingAttachment, legacy_upload_receipt};

const LEGACY_BLOCK: usize = 256 * 1024;

#[derive(Deserialize)]
struct Transfer {
    manifest: Value,
    file: PathBuf,
    device: String,
    thread: String,
    direction: String,
    present: BTreeSet<usize>,
    expires: i64,
}

impl Store {
    pub(crate) fn import_pending_upload(
        &self,
        device: &str,
        scope: &Scope,
        id: Uuid,
        batch: Option<usize>,
    ) -> Result<()> {
        if self.native_upload_exists(id)? {
            return Ok(());
        }
        let (backend, thread) = scope.backend_and_thread();
        let Some(receipt) = legacy_upload_receipt(backend, thread, device, id)? else {
            return Ok(());
        };
        if self.legacy_offset(device, scope, id, &receipt)?.is_some() {
            bail!("此附件正在按旧版字节偏移续传");
        }
        let Some(value) = receipt.transfer(id)? else {
            return Ok(());
        };
        let transfer: Transfer = serde_json::from_value(value)?;
        let manifest = &transfer.manifest;
        let part = receipt.part_path();
        ensure!(
            transfer.device == device
                && transfer.thread == thread
                && transfer.direction == "up"
                && transfer.expires > now()
                && transfer.file == part
                && manifest["id"] == id.to_string()
                && manifest["name"] == receipt.upload.name
                && manifest["size"] == receipt.upload.size
                && manifest["sha256"] == receipt.upload.sha256,
            "旧分块清单不属于此会话"
        );
        let size = receipt.upload.size as usize;
        let hashes: Vec<String> = serde_json::from_value(manifest["hashes"].clone())?;
        ensure!(
            hashes.len() == size.div_ceil(BLOCK)
                && hashes.iter().all(|hash| is_hash(hash))
                && transfer.present.iter().all(|index| *index < hashes.len()),
            "旧分块清单无效"
        );
        let version: Uuid = serde_json::from_value(manifest["version"].clone())?;
        let secret = |field: &str, len| -> Result<String> {
            let value = manifest[field].as_str().context("旧分块清单缺少密钥")?;
            ensure!(STANDARD.decode(value)?.len() == len, "旧分块密钥无效");
            Ok(value.to_owned())
        };
        let key = secret("key", 32)?;
        let nonce = secret("nonce", 8)?;
        let candidates = if receipt.complete {
            (0..hashes.len()).collect()
        } else {
            transfer.present
        };
        self.reserve_upload(size as i64)?;
        let mut destination = self.open_upload_file(id, &receipt.upload.name)?;
        destination.set_len(0)?;
        let mut present = BTreeSet::new();
        if !candidates.is_empty() {
            let source = if receipt.complete {
                receipt.open(false)
            } else {
                receipt.open_pending()
            };
            match source {
                Ok(mut source) => {
                    let mut buffer = vec![0; BLOCK];
                    for index in candidates {
                        let offset = index * BLOCK;
                        let block = &mut buffer[..(size - offset).min(BLOCK)];
                        source.seek(SeekFrom::Start(offset as u64))?;
                        match source.read_exact(block) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                        if format!("{:x}", Sha256::digest(&*block)) == hashes[index] {
                            destination.seek(SeekFrom::Start(offset as u64))?;
                            destination.write_all(block)?;
                            present.insert(index);
                        }
                    }
                }
                Err(error) if error.is::<MissingAttachment>() => {}
                Err(error) => return Err(error),
            }
        }
        destination.sync_all()?;
        let expires = if receipt.complete {
            transfer.expires
        } else {
            transfer.expires.min(receipt.expires)
        };
        let name = receipt.upload.name;
        let value = serde_json::to_string(&Manifest {
            mime: content_type(&name),
            spec: Spec {
                name,
                size,
                sha256: receipt.upload.sha256,
                hashes,
            },
            id,
            version,
            key,
            nonce,
            storage: batch.is_some(),
            storage_batch: batch,
        })?;
        self.db.execute(
            "INSERT INTO native_uploads (id,device,thread,manifest,present,expires) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id.to_string(), device, scope.key(), value, serde_json::to_string(&present)?, expires],
        )?;
        Ok(())
    }

    pub(crate) fn legacy_chunk(
        &self,
        device: &str,
        scope: &Scope,
        id: Uuid,
        offset: u64,
        bytes: &[u8],
    ) -> Result<Value> {
        ensure!(
            (1..=LEGACY_BLOCK).contains(&bytes.len()),
            "旧附件分片大小无效"
        );
        ensure!(!self.native_upload_exists(id)?, "此附件已使用校验分块协议");
        let (backend, thread) = scope.backend_and_thread();
        let receipt = legacy_upload_receipt(backend, thread, device, id)?
            .context("旧附件不属于此会话或已过期")?;
        ensure!(!receipt.complete, "旧附件已完成");
        let progress = self.legacy_offset(device, scope, id, &receipt)?;
        let current = progress.unwrap_or(receipt.offset);
        let end = current + bytes.len() as u64;
        ensure!(
            current == offset && end <= receipt.upload.size,
            "旧附件偏移无效"
        );
        if progress.is_none() {
            self.reserve_upload(receipt.upload.size as i64)?;
        }
        let mut target = self.open_upload_file(id, &receipt.upload.name)?;
        if progress.is_none() {
            target.set_len(0)?;
            if current > 0 {
                let source = receipt.open(true)?;
                let copied = std::io::copy(&mut source.take(current), &mut target)?;
                ensure!(copied == current, "旧附件暂存文件不完整");
            }
        } else {
            ensure!(target.metadata()?.len() >= current, "旧附件暂存文件不完整");
            target.set_len(current)?;
        }
        target.seek(SeekFrom::Start(current))?;
        target.write_all(bytes)?;
        target.sync_all()?;
        self.db.execute(
            "INSERT INTO legacy_upload_progress (id,device,thread,sha256,size,offset,expires)
             VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset",
            params![
                id.to_string(),
                device,
                scope.key(),
                receipt.upload.sha256,
                receipt.upload.size as i64,
                end as i64,
                receipt.expires
            ],
        )?;
        Ok(json!({"offset":end}))
    }

    pub(super) fn finish_legacy_upload(
        &mut self,
        device: &str,
        scope: &Scope,
        id: Uuid,
    ) -> Result<Value> {
        let (backend, thread) = scope.backend_and_thread();
        let receipt = legacy_upload_receipt(backend, thread, device, id)?
            .context("旧附件不属于此会话或已过期")?;
        let file = &receipt.upload;
        if receipt.complete {
            ensure!(
                receipt.open(false)?.metadata()?.len() == file.size,
                "旧附件大小校验失败"
            );
            return Ok(json!({"id":id,"name":file.name,"path":file.path}));
        }
        let progress = self.legacy_offset(device, scope, id, &receipt)?;
        let path = upload_path(&self.directory.join("native-uploads"), id, &file.name);
        let (mut source, mut target) = if let Some(offset) = progress {
            ensure!(offset == file.size, "旧附件尚未传完");
            (private_file(&path, false)?, None)
        } else {
            let source = receipt.open_pending()?;
            ensure!(source.metadata()?.len() == file.size, "旧附件尚未传完");
            self.reserve_upload(file.size as i64)?;
            let target = self.open_upload_file(id, &file.name)?;
            target.set_len(0)?;
            (source, Some(target))
        };
        ensure!(source.metadata()?.len() == file.size, "旧附件大小校验失败");
        let mut remaining = file.size as usize;
        let mut buffer = vec![0; BLOCK];
        let mut whole = Sha256::new();
        let mut hashes = Vec::with_capacity(remaining.div_ceil(BLOCK));
        while remaining > 0 {
            let block = &mut buffer[..remaining.min(BLOCK)];
            source.read_exact(block)?;
            whole.update(&*block);
            hashes.push(format!("{:x}", Sha256::digest(&*block)));
            if let Some(target) = &mut target {
                target.write_all(block)?;
            }
            remaining -= block.len();
        }
        ensure!(
            format!("{:x}", whole.finalize()) == file.sha256,
            "旧附件校验失败"
        );
        if let Some(target) = &target {
            target.sync_all()?;
        }
        let present = serde_json::to_string(&(0..hashes.len()).collect::<Vec<_>>())?;
        let value = serde_json::to_string(&Manifest {
            mime: content_type(&file.name),
            spec: Spec {
                name: file.name.clone(),
                size: file.size as usize,
                sha256: file.sha256.clone(),
                hashes,
            },
            id,
            version: Uuid::new_v4(),
            key: STANDARD.encode(rand::random::<[u8; 32]>()),
            nonce: STANDARD.encode(rand::random::<[u8; 8]>()),
            storage: false,
            storage_batch: None,
        })?;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO native_uploads (id,device,thread,manifest,present,complete,expires) VALUES (?1,?2,?3,?4,?5,1,?6)",
            params![id.to_string(), device, scope.key(), value, present, receipt.expires],
        )?;
        tx.execute(
            "DELETE FROM legacy_upload_progress WHERE id=?1",
            [id.to_string()],
        )?;
        tx.commit()?;
        Ok(json!({"id":id,"name":file.name,"path":path}))
    }

    fn legacy_offset(
        &self,
        device: &str,
        scope: &Scope,
        id: Uuid,
        receipt: &LegacyUpload,
    ) -> Result<Option<u64>> {
        let row: Option<(String, String, String, i64, i64)> = self.db.query_row(
            "SELECT device,thread,sha256,offset,expires FROM legacy_upload_progress WHERE id=?1",
            [id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        let Some((owner, thread, sha256, offset, expires)) = row else {
            return Ok(None);
        };
        ensure!(
            owner == device
                && thread == scope.key()
                && sha256 == receipt.upload.sha256
                && expires > now()
                && (0..=receipt.upload.size as i64).contains(&offset),
            "旧附件不属于此会话或已过期"
        );
        Ok(Some(offset as u64))
    }
}
