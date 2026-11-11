use crate::{files::Attachment, queue, requests};
use serde::Deserialize;
use serde_json::Value;
#[cfg(feature = "official-plugins")]
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;

#[cfg(feature = "official-plugins")]
mod desktop;
#[cfg(feature = "official-plugins")]
pub(crate) use desktop::{Desktop, Thread, native_text, ordered, read_frame};

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Send {
        text: String,
        files: Vec<Attachment>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tools: Vec<Value>,
    },
    Steer {
        text: String,
        expected: String,
        files: Vec<Attachment>,
    },
    Interrupt {
        expected: String,
    },
    Settings {
        input: Value,
    },
    Permission {
        input: Value,
    },
    Respond {
        response: requests::Response,
    },
    Queue {
        change: queue::Change,
    },
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Send { .. } => "send",
            Self::Steer { .. } => "steer",
            Self::Interrupt { .. } => "interrupt",
            Self::Settings { .. } => "settings",
            Self::Permission { .. } => "control",
            Self::Respond { .. } => "respond",
            Self::Queue { change } => change.name(),
        }
    }
}

#[derive(Deserialize, serde::Serialize)]
pub enum Outcome {
    Completed(Option<Uuid>),
    Rejected(String),
    Uncertain,
    Accepted(String),
    Interrupted(String),
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct View {
    pub thread: Value,
    pub messages: Vec<Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub expanded: HashMap<String, String>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub activities: HashMap<String, Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub pending: Vec<Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub inline: Arc<HashMap<String, String>>,
    pub turns: Vec<Turn>,
    pub epoch: Uuid,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub disabled_plugins: Vec<String>,
}

impl View {
    pub(crate) fn mark(&self) -> (Uuid, u64, Option<String>) {
        (
            self.epoch,
            self.thread["revision"].as_u64().unwrap_or_default(),
            self.thread["queueFingerprint"].as_str().map(str::to_owned),
        )
    }
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct Turn {
    pub id: String,
    pub request: Option<String>,
    pub state: String,
}
