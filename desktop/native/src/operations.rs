use crate::{
    codex_live::{Action, Outcome, View},
    plugins::{Delivery, Observation, Write},
    state::{Store, hash, now},
};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

const COLUMNS: &str =
    "id,thread_id,kind,state,turn_id,error,created,updated,result_thread_id,backend_id";

impl Store {
    pub fn begin_operation(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: Uuid,
        action: &Action,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            &thread.to_string(),
            action.name(),
            json!([thread, action]),
        )
    }

    pub fn begin_management(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        kind: &str,
        input: &impl serde::Serialize,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            thread,
            kind,
            json!([thread, kind, input]),
        )
    }

    pub(crate) fn begin_plugin(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        action: &Write,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            thread,
            action.kind(),
            json!([thread, action]),
        )
    }

    fn begin(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        kind: &str,
        input: Value,
    ) -> Result<(Value, bool)> {
        let time = now();
        let id = id.to_string();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let fingerprint = hash(&serde_json::to_string(&input)?);
        let old: Option<(String, String, Value)> = tx.query_row(
            &format!("SELECT device_id,fingerprint,{COLUMNS} FROM operations WHERE backend_id=?1 AND id=?2"),
            params![backend, id],
            |row| Ok((row.get(0)?, row.get(1)?, operation(row, 2)?)),
        ).optional()?;
        if let Some((owner, actual, operation)) = old {
            ensure!(
                owner == device && actual == fingerprint,
                "请求 ID 已用于其他操作"
            );
            return Ok((operation, false));
        }
        let busy = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE backend_id=?1 AND thread_id=?2 AND state='dispatching')",
            params![backend, thread], |row| row.get::<_, bool>(0),
        )?;
        let (state, error) = if busy {
            ("rejected", Some("此会话有一个控制请求正在确认"))
        } else {
            ("dispatching", None)
        };
        tx.execute(
            "INSERT INTO operations (id,device_id,thread_id,kind,fingerprint,state,error,created,updated,backend_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
            params![id, device, thread, kind, fingerprint, state, error, time, backend],
        )?;
        let result = tx.query_row(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND id=?2"),
            params![backend, id],
            |row| operation(row, 0),
        )?;
        tx.commit()?;
        Ok((result, !busy))
    }

    pub fn finish_operation(&mut self, backend: &str, id: Uuid, outcome: Outcome) -> Result<()> {
        let (state, turn, error, result) = match outcome {
            Outcome::Completed(result) => {
                ("completed", None, None, result.map(|id| id.to_string()))
            }
            Outcome::Rejected(message) => ("rejected", None, Some(message), None),
            Outcome::Uncertain => (
                "uncertain",
                None,
                Some("结果待确认，请在 Codex 会话中核对".to_owned()),
                None,
            ),
            Outcome::Accepted(turn) => ("accepted", Some(turn), None, None),
            Outcome::Interrupted(turn) => ("interrupted", Some(turn), None, None),
        };
        self.db.execute(
            "UPDATE operations SET state=?1,turn_id=COALESCE(?2,turn_id),error=?3,updated=?4,result_thread_id=?5
             WHERE backend_id=?6 AND id=?7 AND state='dispatching'",
            params![state, turn, error, now(), result, backend, id.to_string()],
        )?;
        Ok(())
    }

    pub(crate) fn finish_plugin(
        &mut self,
        backend: &str,
        id: Uuid,
        result: Delivery,
    ) -> Result<()> {
        let (state, turn, error, thread) = match result {
            Delivery::Accepted(turn) => ("accepted", turn, None, None),
            Delivery::Completed(thread) => ("completed", None, None, thread),
            Delivery::Command {
                id,
                succeeded: true,
            } => ("completed", Some(id), None, None),
            Delivery::Command {
                id,
                succeeded: false,
            } => ("failed", Some(id), Some("DSH 原生命令执行失败"), None),
            Delivery::Rejected(reason) => ("rejected", None, Some(reason), None),
            Delivery::Uncertain => (
                "uncertain",
                None,
                Some("结果待确认，请在原会话中核对"),
                None,
            ),
        };
        self.db.execute(
            "UPDATE operations SET state=?1,turn_id=?2,error=?3,updated=?4,result_thread_id=COALESCE(?5,result_thread_id)
             WHERE backend_id=?6 AND id=?7 AND state='dispatching'",
            params![state, turn, error, now(), thread, backend, id.to_string()],
        )?;
        Ok(())
    }

    pub(crate) fn record_plugin_thread(
        &mut self,
        backend: &str,
        id: Uuid,
        thread: &str,
    ) -> Result<()> {
        let changed = self.db.execute(
            "UPDATE operations SET result_thread_id=?1,updated=?2
             WHERE backend_id=?3 AND id=?4 AND kind='create' AND state='dispatching'
               AND (result_thread_id IS NULL OR result_thread_id=?1)",
            params![thread, now(), backend, id.to_string()],
        )?;
        ensure!(changed == 1, "无法保存新会话标识");
        Ok(())
    }

    pub(crate) fn observe_plugin(
        &mut self,
        backend: &str,
        thread: &str,
        events: &[Observation],
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut update = tx.prepare(
            "UPDATE operations SET state=?1,turn_id=?2,error=NULL,updated=?3
             WHERE backend_id=?4 AND thread_id=?5
               AND ((kind IN ('send','steer','queue') AND id=?6)
                    OR (kind='interrupt' AND ?1<>'accepted' AND turn_id=?2))
               AND state IN ('dispatching','accepted','uncertain')
               AND (state<>?1 OR turn_id IS NOT ?2)",
        )?;
        for event in events {
            update.execute(params![
                event.state,
                event.turn,
                now(),
                backend,
                thread,
                event.request.map(|id| id.to_string()),
            ])?;
        }
        drop(update);
        tx.commit()?;
        Ok(())
    }

    pub fn observe_operations(&mut self, backend: &str, thread: &str, view: &View) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut update = tx.prepare(
            "UPDATE operations SET state=?1,turn_id=?2,error=NULL,updated=?3
             WHERE backend_id=?4 AND thread_id=?5 AND kind IN ('send','steer','respond')
               AND state IN ('dispatching','accepted','uncertain')
               AND (turn_id=?2 OR id=?6)
               AND (state<>?1 OR turn_id IS NULL)",
        )?;
        for turn in &view.turns {
            if !matches!(
                turn.state.as_str(),
                "accepted" | "completed" | "interrupted" | "failed"
            ) {
                continue;
            }
            update.execute(params![
                turn.state,
                turn.id,
                now(),
                backend,
                thread,
                turn.request
            ])?;
        }
        drop(update);
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn operation_for(
        &self,
        backend: &str,
        device: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        Ok(self.db.query_row(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND device_id=?2 AND id=?3"),
            params![backend, device, id], |row| operation(row, 0),
        ).optional()?)
    }

    pub(crate) fn recent_operations_for(
        &self,
        backend: &str,
        device: &str,
        thread: &str,
    ) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND device_id=?2 AND thread_id=?3 ORDER BY created DESC LIMIT 20"),
        )?;
        Ok(stmt
            .query_map(params![backend, device, thread], |row| operation(row, 0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn revoke_device(&mut self, device: &str) -> Result<()> {
        self.db
            .execute("UPDATE devices SET revoked=1 WHERE id=?1", [device])?;
        Ok(())
    }
}

fn operation(row: &Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    let mut result = json!({
        "id": row.get::<_, String>(offset)?,
        "threadId": row.get::<_, String>(offset + 1)?,
        "kind": row.get::<_, String>(offset + 2)?,
        "state": row.get::<_, String>(offset + 3)?,
        "turnId": row.get::<_, Option<String>>(offset + 4)?,
        "error": row.get::<_, Option<String>>(offset + 5)?,
        "createdAt": row.get::<_, i64>(offset + 6)?,
        "updatedAt": row.get::<_, i64>(offset + 7)?,
        "backendId": row.get::<_, String>(offset + 9)?,
    });
    if let Some(thread) = row.get::<_, Option<String>>(offset + 8)? {
        result["resultThreadId"] = json!(thread);
    }
    Ok(result)
}
