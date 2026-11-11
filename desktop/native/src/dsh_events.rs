use crate::{
    dsh::{Dsh, Refused, Session},
    plugins::{Delivery, View},
    requests::Response,
    state::hash,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::watch,
    task::JoinSet,
    time::{interval, sleep, timeout},
};
use uuid::Uuid;

const MAX_PENDING: usize = 64;
const MAX_SEEN: usize = 4096;

pub(crate) struct Hub {
    state: Arc<State>,
    updates: watch::Receiver<u64>,
}

struct State {
    updates: watch::Sender<u64>,
    data: Mutex<Data>,
}

#[derive(Default)]
struct Data {
    online: Option<Connection>,
    pending: BTreeMap<Uuid, Pending>,
    seen: HashSet<Uuid>,
    seen_order: VecDeque<Uuid>,
}

#[derive(Clone)]
struct Connection {
    session: Session,
    client: Uuid,
}

struct Pending {
    thread: String,
    card: Value,
    wait: Wait,
    replying: bool,
}

enum Wait {
    Indefinite,
    Attaching(Instant),
    Until(Instant),
}

impl Wait {
    fn ready(&self) -> bool {
        match self {
            Self::Indefinite => true,
            Self::Until(deadline) => *deadline > Instant::now(),
            Self::Attaching(_) => false,
        }
    }
}

impl Data {
    fn remember(&mut self, event: Uuid) -> bool {
        if !self.seen.insert(event) {
            return false;
        }
        self.seen_order.push_back(event);
        if self.seen_order.len() > MAX_SEEN
            && let Some(old) = self.seen_order.pop_front()
        {
            self.seen.remove(&old);
        }
        true
    }
}

impl State {
    fn notify(&self) {
        self.updates.send_modify(|revision| *revision += 1);
    }

    fn connected(&self, connection: Option<Connection>) {
        *self.data.lock().expect("DSH event state poisoned") = Data {
            online: connection,
            ..Data::default()
        };
        self.notify();
    }
}

impl Hub {
    pub(crate) fn start(dsh: Arc<Dsh>) -> Arc<Self> {
        let (updates, receiver) = watch::channel(0);
        let state = Arc::new(State {
            updates,
            data: Mutex::new(Data::default()),
        });
        tokio::spawn(run(dsh, state.clone()));
        Arc::new(Self {
            state,
            updates: receiver,
        })
    }

    pub(crate) fn updates(&self) -> watch::Receiver<u64> {
        self.updates.clone()
    }

    pub(crate) fn decorate(&self, thread: &str, view: &mut View) {
        let data = self.state.data.lock().expect("DSH event state poisoned");
        let Some(online) = &data.online else { return };
        let mut cards: Vec<_> = data
            .pending
            .values()
            .filter(|pending| {
                pending.thread == thread
                    && !pending.replying
                    && pending.wait.ready()
                    && pending.card["turnId"] == view.thread["activeTurnId"]
            })
            .map(|pending| pending.card.clone())
            .collect();
        for question in view
            .continued_questions
            .as_array()
            .into_iter()
            .flatten()
            .take(MAX_PENDING)
        {
            if let Some(card) = continued_card(online.client, thread, question) {
                cards.push(card);
            }
        }
        view.thread["pendingRequests"] = json!(cards.len());
        view.thread["requests"] = json!(cards);
    }

    pub(crate) async fn respond(
        &self,
        dsh: &Dsh,
        thread: &str,
        view: &View,
        response: Response,
    ) -> Delivery {
        let Some(card) = view.thread["requests"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|card| card["id"] == response.target_request_id)
        else {
            return Delivery::Rejected("DSH 请求已回答、取消或过期");
        };
        let Ok(value) = response.dsh_value(card) else {
            return Delivery::Rejected("DSH 响应与当前卡片不匹配");
        };
        if card["kind"] == "async-question" {
            return self.answer_continued(dsh, thread, card, value).await;
        }
        let started = {
            let mut data = self.state.data.lock().expect("DSH event state poisoned");
            let online = data.online.clone();
            let current = dsh.watched_view(thread);
            data.pending.iter_mut().find_map(|(event, pending)| {
                if pending.thread == thread
                    && pending.card == *card
                    && !pending.replying
                    && current
                        .as_ref()
                        .is_some_and(|view| view.thread["activeTurnId"] == card["turnId"])
                    && pending.wait.ready()
                {
                    let online = online.clone()?;
                    pending.replying = true;
                    return Some((*event, online));
                }
                None
            })
        };
        let Some((event, online)) = started else {
            return Delivery::Rejected("DSH 请求已回答、取消或过期");
        };
        self.state.notify();
        let result = outcome(dsh, &online, event, json!({"kind":"result","value":value})).await;
        let (same_connection, still_pending) = {
            let mut data = self.state.data.lock().expect("DSH event state poisoned");
            let same_connection = data
                .online
                .as_ref()
                .is_some_and(|current| current.client == online.client);
            (
                same_connection,
                same_connection && data.pending.remove(&event).is_some(),
            )
        };
        self.state.notify();
        match result {
            Ok(()) if same_connection && still_pending => Delivery::Completed(None),
            Ok(()) if same_connection => Delivery::Rejected("DSH 请求已由原生端结束"),
            Err(error) if error.is::<Refused>() => Delivery::Rejected("DSH 拒绝响应"),
            _ => Delivery::Uncertain,
        }
    }

    async fn answer_continued(
        &self,
        dsh: &Dsh,
        thread: &str,
        card: &Value,
        answer: Value,
    ) -> Delivery {
        let online = self
            .state
            .data
            .lock()
            .expect("DSH event state poisoned")
            .online
            .clone();
        let Some(online) = online else {
            return Delivery::Rejected("DSH 交互连接不可用");
        };
        let Ok(projections) = dsh.projections(thread).await else {
            return Delivery::Rejected("DSH 问题状态无法确认");
        };
        let matched = projections["userQuestions"]["active"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|question| {
                continued_card(online.client, thread, question).as_ref() == Some(card)
            });
        let Some(call_id) = matched.and_then(|q| q["callId"].as_str()) else {
            return Delivery::Rejected("DSH 后续问题已回答或过期");
        };
        let current = self
            .state
            .data
            .lock()
            .expect("DSH event state poisoned")
            .online
            .as_ref()
            .is_some_and(|current| current.client == online.client);
        if !current || dsh.watched_view(thread).is_none() {
            return Delivery::Rejected("DSH 交互连接已更换");
        }
        match dsh
            .exchange(
                &online.session,
                "userQuestions/answer",
                json!({
                    "agentId":thread,"callId":call_id,"answer":answer
                }),
            )
            .await
        {
            Ok(Value::Bool(true)) => Delivery::Completed(None),
            Ok(Value::Bool(false)) => Delivery::Rejected("DSH 后续问题已回答或取消"),
            Err(error) if error.is::<Refused>() => Delivery::Rejected("DSH 拒绝回答"),
            _ => Delivery::Uncertain,
        }
    }
}

async fn run(dsh: Arc<Dsh>, state: Arc<State>) {
    let mut wait = Duration::from_millis(500);
    loop {
        let connected = tokio::select! {
            _ = state.updates.closed() => return,
            result = timeout(Duration::from_secs(10), async {
                let session = dsh.connect("answer").await?;
                let mut follow = dsh.open_stream(&session, "$events", json!({})).await?;
                let (ready, _) = follow.next().await?;
                ensure!(ready["type"] == "ready", "DSH 交互连接未就绪");
                let client = uuid(&ready["clientId"]).context("DSH 交互连接标识无效")?;
                Ok::<_, anyhow::Error>((Connection { session, client }, follow))
            }) => result,
        };
        if let Ok(Ok((online, follow))) = connected {
            state.connected(Some(online.clone()));
            let result = listen(&dsh, &state, &online, follow).await;
            state.connected(None);
            if result.is_ok() {
                return;
            }
            wait = Duration::from_millis(500);
        }
        tokio::select! {
            _ = state.updates.closed() => return,
            _ = sleep(wait) => {}
        }
        wait = (wait * 2).min(Duration::from_secs(8));
    }
}

async fn listen(
    dsh: &Arc<Dsh>,
    state: &State,
    online: &Connection,
    mut follow: crate::dsh::Follow,
) -> Result<()> {
    let mut delegates = JoinSet::new();
    let mut waits = HashMap::<String, Uuid>::new();
    let mut ticks = interval(Duration::from_millis(250));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_frame = Instant::now();
    let mut ping = false;
    loop {
        tokio::select! {
            _ = state.updates.closed() => {
                let pending: Vec<_> = state.data.lock().expect("DSH event state poisoned")
                    .pending.iter().filter(|(_, value)| !value.replying).map(|(id, _)| *id).collect();
                for event in pending {
                    delegate(&mut delegates, dsh, online, event)?;
                }
                let _ = timeout(Duration::from_secs(3), async { while delegates.join_next().await.is_some() {} }).await;
                return Ok(());
            }
            Some(result) = delegates.join_next(), if !delegates.is_empty() => {
                result??;
            }
            _ = ticks.tick() => {
                ensure!(last_frame.elapsed() < Duration::from_secs(40), "DSH 交互连接超时");
                if !ping && last_frame.elapsed() >= Duration::from_secs(20) {
                    follow.ping().await?;
                    ping = true;
                }
                let (releases, cancelled) = {
                    let mut data = state.data.lock().expect("DSH event state poisoned");
                    let releases: Vec<_> = data.pending.iter().filter(|(_, pending)| !pending.replying && (
                        dsh.watched_view(&pending.thread).is_none_or(|view| view.thread["activeTurnId"] != pending.card["turnId"])
                        || matches!(pending.wait, Wait::Attaching(deadline) | Wait::Until(deadline) if deadline <= Instant::now())
                    )).map(|(event, _)| *event).collect();
                    for event in &releases { data.pending.remove(event); }
                    let cancelled: Vec<_> = waits.iter().filter(|(_, event)| !data.pending.contains_key(event))
                        .map(|(stream, _)| stream.clone()).collect();
                    (releases, cancelled)
                };
                for stream in cancelled {
                    waits.remove(&stream);
                    follow.cancel(&stream).await?;
                }
                if !releases.is_empty() { state.notify(); }
                for event in releases { delegate(&mut delegates, dsh, online, event)?; }
            }
            packet = follow.packet() => {
                last_frame = Instant::now();
                ping = false;
                let Some((frame, _)) = packet? else { continue };
                if let Some(stream) = frame["streamId"].as_str().filter(|id| *id != follow.stream) {
                    let Some(&event) = waits.get(stream) else { continue };
                    if let Some(remaining) = frame["value"]["remainingMs"].as_u64().filter(|remaining| frame["type"] == "item" && *remaining <= i32::MAX as u64) {
                        let mut data = state.data.lock().expect("DSH event state poisoned");
                        if let Some(pending) = data.pending.get_mut(&event).filter(|pending| matches!(pending.wait, Wait::Attaching(_))) {
                            pending.wait = Wait::Until(Instant::now() + Duration::from_millis(remaining));
                            state.notify();
                        }
                    } else {
                        waits.remove(stream);
                        let mut data = state.data.lock().expect("DSH event state poisoned");
                        if let Some(pending) = data.pending.get_mut(&event).filter(|pending| !pending.replying) {
                            pending.wait = Wait::Until(Instant::now());
                        }
                    }
                    continue;
                }
                ensure!(frame["type"] == "item", "DSH 交互连接已结束");
                let item = &frame["value"];
                match item["type"].as_str() {
                    Some("cancel") => {
                        if let Some(event) = uuid(&item["eventId"]) {
                            let mut data = state.data.lock().expect("DSH event state poisoned");
                            data.remember(event);
                            if data.pending.remove(&event).is_some() { state.notify(); }
                        }
                    }
                    Some("waterfall") => {
                        let Some(event) = uuid(&item["eventId"]) else { continue };
                        let prepared = prepare(dsh, online.client, event, item);
                        let call = {
                            let mut data = state.data.lock().expect("DSH event state poisoned");
                            if data.pending.contains_key(&event) || !data.remember(event) { continue; }
                            prepared.filter(|_| data.pending.len() < MAX_PENDING).map(|(pending, call)| {
                                data.pending.insert(event, pending);
                                state.notify();
                                call
                            })
                        };
                        match call {
                            None => delegate(&mut delegates, dsh, online, event)?,
                            Some(Some((thread, call))) => {
                                let stream = follow.open("userQuestions/attachWait", json!({"agentId":thread,"callId":call})).await?;
                                waits.insert(stream, event);
                            }
                            Some(None) => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn delegate(
    jobs: &mut JoinSet<Result<()>>,
    dsh: &Arc<Dsh>,
    online: &Connection,
    event: Uuid,
) -> Result<()> {
    ensure!(jobs.len() < MAX_PENDING * 2, "DSH 待释放交互过多");
    let (dsh, online) = (dsh.clone(), online.clone());
    jobs.spawn(async move { outcome(&dsh, &online, event, json!({"kind":"next"})).await });
    Ok(())
}

async fn outcome(dsh: &Dsh, online: &Connection, event: Uuid, outcome: Value) -> Result<()> {
    dsh.exchange(
        &online.session,
        "$events/result",
        json!({
            "clientId":online.client,"eventId":event,"outcome":outcome
        }),
    )
    .await?;
    Ok(())
}

fn prepare(
    dsh: &Dsh,
    client: Uuid,
    event: Uuid,
    item: &Value,
) -> Option<(Pending, Option<(String, String)>)> {
    let thread = item["agentId"].as_str()?;
    let view = dsh.watched_view(thread)?;
    let request = &item["request"];
    let id = format!("dsh:{client}:{event}");
    let fingerprint = hash(&json!([client, event, thread, request]).to_string());
    let mut wait = Wait::Indefinite;
    let mut timed = None;
    let mut card = json!({
        "id":id,"fingerprint":fingerprint,"actionable":true,"turnId":view.thread["activeTurnId"]
    });
    match item["event"].as_str()? {
        "approval/request" => {
            card["kind"] = json!("command");
            card["title"] = json!(text(&request["toolName"], 300)?);
            card["description"] = json!(
                ["zh", "en"]
                    .into_iter()
                    .find_map(|language| text(&request["displayReason"][language], 16_000))
                    .or_else(|| text(&request["reason"], 16_000))
                    .unwrap_or_default()
            );
            card["decisions"] = json!(["accept", "decline", "cancel"]);
        }
        "user-questions/request" => {
            card["kind"] = json!("question");
            card["title"] = json!("DSH 提问");
            card["questions"] = questions(&request["questions"])?;
            if request["wait"]["timed"] == true {
                let call = text(&request["wait"]["callId"], 200)?;
                timed = Some((thread.to_owned(), call.to_owned()));
                wait = Wait::Attaching(Instant::now() + Duration::from_secs(4));
            }
        }
        _ => return None,
    }
    Some((
        Pending {
            thread: thread.to_owned(),
            card,
            wait,
            replying: false,
        },
        timed,
    ))
}

fn continued_card(client: Uuid, thread: &str, question: &Value) -> Option<Value> {
    if question["state"] != "continued" {
        return None;
    }
    let call = text(&question["callId"], 200)?;
    let id = format!("dsh-continued:{client}:{call}");
    let fingerprint = hash(&json!([client, thread, call, question["questions"]]).to_string());
    Some(json!({
        "id":id,"fingerprint":fingerprint,"kind":"async-question","title":"DSH 后续问题",
        "description":"原生等待已结束，回答会交给 DSH 继续处理。",
        "turnId":null,"actionable":true,"questions":questions(&question["questions"])?
    }))
}

fn questions(raw: &Value) -> Option<Value> {
    let rows = raw
        .as_array()
        .filter(|rows| (1..=20).contains(&rows.len()))?;
    let mut ids = HashSet::new();
    let mut result = Vec::with_capacity(rows.len());
    for question in rows {
        let id = text(&question["id"], 200)?;
        if !ids.insert(id) {
            return None;
        }
        let mut options = Vec::new();
        let mut labels = HashSet::new();
        for option in question["options"].as_array().into_iter().flatten() {
            let label = text(&option["label"], 2_000)?;
            if options.len() == 20 || !labels.insert(label) {
                return None;
            }
            options.push(json!({"label":label,"description":text(&option["description"], 4_000).unwrap_or_default()}));
        }
        result.push(json!({
            "id":id,"header":text(&question["header"], 300).unwrap_or_default(),
            "question":text(&question["question"], 16_000)?,
            "detail":text(&question["detail"], 32_000),
            "multiSelect":question["multiSelect"] == true,
            "intent":text(&question["intent"]["kind"], 100),
            "options":options,
        }));
    }
    Some(json!(result))
}

fn text(value: &Value, limit: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= limit)
}

fn uuid(value: &Value) -> Option<Uuid> {
    Uuid::parse_str(value.as_str()?).ok()
}
