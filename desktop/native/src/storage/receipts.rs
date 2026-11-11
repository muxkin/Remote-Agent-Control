use super::{GRANT_TTL_MS, OBJECT_TTL_MS, Storage, now};
use crate::{files::Scope, gateway::Database, state::Store};
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior, params};
use std::time::Duration;
use tokio::time::{interval, timeout};
use uuid::Uuid;

const ACTIVE_PER_DEVICE: i64 = 32;
const RECEIPTS_PER_DEVICE: i64 = 256;
const CLEANUP_BATCH: usize = 8;

pub(crate) fn initialize(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_storage_objects (
           id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, transfer TEXT NOT NULL,
           indices TEXT NOT NULL, download INTEGER NOT NULL, expires INTEGER NOT NULL,
           grant_expires INTEGER NOT NULL
         );",
    )?;
    let has_grant: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('native_storage_objects') WHERE name='grant_expires')",
        [],
        |row| row.get(0),
    )?;
    if !has_grant {
        // The old expiry represented the initial 15-minute grant, not the life of the object.
        tx.execute(
            "ALTER TABLE native_storage_objects ADD COLUMN grant_expires INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        tx.execute(
            "UPDATE native_storage_objects SET grant_expires=expires, expires=expires+?1",
            [OBJECT_TTL_MS - GRANT_TTL_MS],
        )?;
    }
    tx.execute(
        "CREATE INDEX IF NOT EXISTS storage_receipts_by_device ON native_storage_objects(device,expires)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

impl Store {
    pub(super) fn record_storage_object(
        &self,
        object: Uuid,
        device: &str,
        scope: &Scope,
        transfer: Uuid,
        indices: &[usize],
        download: bool,
    ) -> Result<()> {
        let time = now();
        let (recoverable, active): (i64, i64) = self.db.query_row(
            "SELECT count(*),coalesce(sum(grant_expires>?2),0)
             FROM native_storage_objects WHERE device=?1 AND expires>?2",
            params![device, time],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(
            active < ACTIVE_PER_DEVICE && recoverable < RECEIPTS_PER_DEVICE,
            "待处理对象存储批次过多"
        );
        self.db.execute(
            "INSERT INTO native_storage_objects
             (id,device,thread,transfer,indices,download,expires,grant_expires)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                object.to_string(),
                device,
                scope.key(),
                transfer.to_string(),
                serde_json::to_string(indices)?,
                download,
                time + OBJECT_TTL_MS,
                time + GRANT_TTL_MS,
            ],
        )?;
        Ok(())
    }
}

impl Storage {
    pub(crate) async fn cleanup_expired(self, db: Database) {
        let mut tick = interval(Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut after = String::new();
        loop {
            tick.tick().await;
            if let Ok(next) = self.remove_expired_batch(&db, &after).await {
                after = next;
            }
        }
    }

    pub(super) async fn remove_expired_batch(&self, db: &Database, after: &str) -> Result<String> {
        let ids = {
            let store = db.lock().expect("database mutex poisoned");
            let mut query = store.db.prepare(
                "SELECT id FROM native_storage_objects WHERE id>?1 AND expires<=?2
                 ORDER BY id LIMIT ?3",
            )?;
            query
                .query_map(params![after, now(), CLEANUP_BATCH as i64], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            let Ok(object) = Uuid::parse_str(id) else {
                continue;
            };
            let key = self.inner.key(object);
            if timeout(Duration::from_secs(8), self.inner.provider.remove(&key))
                .await
                .is_ok_and(|result| result.is_ok())
            {
                db.lock().expect("database mutex poisoned").db.execute(
                    "DELETE FROM native_storage_objects WHERE id=?1 AND expires<=?2",
                    params![id, now()],
                )?;
            }
        }
        // Continue past a failed deletion so other expired objects can still be cleaned up.
        Ok(if ids.len() == CLEANUP_BATCH {
            ids.last().cloned().unwrap_or_default()
        } else {
            String::new()
        })
    }
}
