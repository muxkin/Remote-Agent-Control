use crate::{
    app_tools::{AppTools, Tool, call},
    state::now,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::Mutex,
    time::{Instant, timeout},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Usage {
    tools: AppTools,
    cached: Arc<Mutex<Option<(Instant, Value)>>>,
}

impl Usage {
    pub fn new(tools: AppTools) -> Self {
        Self {
            tools,
            cached: Default::default(),
        }
    }

    pub async fn read(&self, anchor: Uuid) -> Value {
        let mut cache = self.cached.lock().await;
        if let Some((time, value)) = &*cache {
            if time.elapsed() < Duration::from_secs(30) {
                return value.clone();
            }
        }
        let value = match timeout(Duration::from_secs(5), self.fetch(anchor)).await {
            Ok(Ok(value)) => value,
            _ => unavailable("本机桌面用量暂不可用"),
        };
        *cache = Some((Instant::now(), value.clone()));
        value
    }

    async fn fetch(&self, anchor: Uuid) -> Result<Value> {
        let mut stream = self.tools.connect(Tool::Usage).await?;
        let value = call(
            &mut stream,
            &anchor.to_string(),
            Uuid::new_v4(),
            Tool::Usage,
            json!({}),
        )
        .await?;
        Ok(normalize(&value))
    }
}

pub fn unavailable(reason: &str) -> Value {
    json!({"available":false,"updatedAt":now(),"buckets":[],"reason":reason})
}

fn normalize(value: &Value) -> Value {
    let limits: Vec<_> = if let Some(limits) = value["rateLimitsByLimitId"]
        .as_object()
        .filter(|limits| !limits.is_empty())
    {
        limits
            .iter()
            .map(|(id, limit)| (id.as_str(), limit))
            .collect()
    } else {
        let limit = &value["rateLimits"];
        vec![(limit["limitId"].as_str().unwrap_or("codex"), limit)]
    };
    let buckets: Vec<_> = limits
        .into_iter()
        .filter_map(|(id, limit)| {
            let windows: Vec<_> = ["primary", "secondary"]
                .into_iter()
                .enumerate()
                .filter_map(|(index, key)| {
                    let window = &limit[key];
                    let percent = window["usedPercent"].as_f64()?.clamp(0.0, 100.0);
                    let duration = window["windowDurationMins"]
                        .as_u64()
                        .filter(|minutes| *minutes > 0);
                    let label = match duration {
                        Some(10080) => "每周用量".into(),
                        Some(300) => "5 小时用量".into(),
                        Some(minutes) => format!("{minutes} 分钟用量"),
                        None if index == 0 => "当前用量".into(),
                        None => "长期用量".into(),
                    };
                    let mut result = json!({"label":label,"usedPercent":percent});
                    if let Some(minutes) = duration {
                        result["durationMinutes"] = json!(minutes);
                    }
                    if let Some(reset) = window["resetsAt"]
                        .as_i64()
                        .filter(|seconds| *seconds > 0)
                        .and_then(|seconds| seconds.checked_mul(1000))
                    {
                        result["resetsAt"] = json!(reset);
                    }
                    Some(result)
                })
                .collect();
            if windows.is_empty() {
                return None;
            }
            let mut result =
                json!({"id":id,"name":limit["limitName"].as_str().unwrap_or(id),"windows":windows});
            if let Some(plan) = limit["planType"].as_str() {
                result["plan"] = json!(plan);
            }
            Some(result)
        })
        .collect();
    if buckets.is_empty() {
        return unavailable("当前账户暂未提供用量信息");
    }
    json!({"available":true,"updatedAt":now(),"buckets":buckets})
}
