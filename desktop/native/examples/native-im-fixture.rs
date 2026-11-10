use anyhow::{Context, Result, ensure};
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{sync::watch, time::timeout};
use webrtc::{
    media_stream::{
        MediaStreamTrack,
        track_local::{TrackLocal, static_rtp::TrackLocalStaticRTP},
        track_remote::{TrackRemote, TrackRemoteEvent},
    },
    peer_connection::{
        MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
        RTCConfigurationBuilder, RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState,
        RTCSessionDescription,
    },
};

#[tokio::main]
async fn main() -> Result<()> {
    assert!(std::env::var_os("POCKET_NATIVE_ENROLLMENT").is_none());
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    if input.fill_buf()?.starts_with(b"Content-Length: ") {
        return calls(input, output).await;
    }
    let mut event = String::new();
    input.read_line(&mut event)?;
    let request: Value = serde_json::from_str(&event)?;
    assert_eq!(request["sdk"], 1);
    let message = &request["event"]["message"];
    if request["protocol"] == "rpc" {
        return messages(input, output, message).await;
    }
    let text = message["text"].as_str().expect("fixture message");
    let response = match text {
        "迁移前的旧消息" => panic!("saved cursor replayed a message"),
        "从旧客户端发来的加密消息 👋" => json!({"replies":[{"text":"Rust 回复 🔒"}]}),
        _ => json!({}),
    };
    serde_json::to_writer(&mut output, &response)?;
    Ok(())
}

async fn messages(mut input: impl BufRead, mut output: impl Write, message: &Value) -> Result<()> {
    let mut sequence = 0;
    let mut call = |method: &str, params: Value| -> Result<Value> {
        sequence += 1;
        let id = sequence.to_string();
        let request = if method == "done" {
            json!({"id":id,"method":method})
        } else {
            json!({"id":id,"method":method,"params":params})
        };
        serde_json::to_writer(&mut output, &request)?;
        writeln!(output)?;
        output.flush()?;
        let mut line = String::new();
        ensure!(
            input.read_line(&mut line)? > 0,
            "adapter closed the RPC connection"
        );
        let reply: Value = serde_json::from_str(&line)?;
        assert_eq!(reply["id"], id);
        Ok(reply)
    };
    let scenario = message["text"].as_str().unwrap_or_default();
    match scenario {
        "验证加密交互" | "验证旧版卡片" => send_cards(&mut call, message, scenario)?,
        "Rust 交互卡片" => receive_card(&mut call, message)?,
        _ => {}
    }
    if scenario == "验证加密附件" {
        let media = PathBuf::from(
            std::env::var_os("RUST_IM_FIXTURE_MEDIA").context("missing media folder")?,
        );
        let attachment = &message["attachments"][0];
        assert_eq!(attachment["name"], "旧 Node 附件.pdf");
        assert_eq!(attachment["mime"], "application/pdf");
        let message_id = message["id"].as_str().unwrap();
        let output = media.join(format!("{message_id}.pdf"));
        let download = json!({"fileId":attachment["id"],"path":output});
        for _ in 0..2 {
            let result = call("attachment.download", download.clone())?;
            assert_eq!(result["result"]["name"], attachment["name"], "{result}");
        }
        let bytes = fs::read(&output)?;
        assert_eq!(bytes.len(), 1_100_000);
        assert!(bytes.starts_with(b"%PDF-"));
        let upload = json!({"fileId":message_id,"path":output,"name":"Rust 回传.pdf"});
        for _ in 0..2 {
            let result = call("attachment.upload", upload.clone())?;
            assert_eq!(result["result"]["id"], message_id, "{result}");
            assert_eq!(result["result"]["mime"], "application/pdf");
            assert_eq!(
                result["result"]["url"],
                format!(
                    "/api/im/conversations/{}/files/{message_id}/encrypted.pocket",
                    message["conversationId"].as_str().unwrap()
                )
            );
        }
        let mut changed = upload.clone();
        changed["name"] = json!("不同附件名.pdf");
        assert_eq!(call("attachment.upload", changed)?["error"]["status"], 409);
        let result = call(
            "message.send",
            json!({
                "clientId":format!("fixture-file-{message_id}"),"text":"",
                "options":{"attachmentIds":[message_id],"replyTo":message_id},
            }),
        )?;
        assert_eq!(
            result["result"]["attachments"][0]["name"], "Rust 回传.pdf",
            "{result}"
        );

        let mut changed_bytes = bytes.clone();
        changed_bytes[1_000] ^= 1;
        fs::write(&output, &changed_bytes)?;
        assert_eq!(call("attachment.upload", upload)?["error"]["status"], 409);
        assert_eq!(
            call("attachment.download", download.clone())?["error"]["status"],
            409
        );
        assert_eq!(fs::read(&output)?, changed_bytes);
        let staged = call(
            "attachment.upload",
            json!({"path":output,"name":"staged.txt"}),
        )?;
        let staged_id = &staged["result"]["id"];
        assert!(staged_id.is_string(), "{staged}");
        assert_eq!(
            call("attachment.remove", json!({"fileId":staged_id}))?["result"]["ok"],
            true
        );
        assert_eq!(
            call(
                "attachment.download",
                json!({"fileId":staged_id,"path":output})
            )?["error"]["status"],
            404
        );
        fs::write(&output, bytes)?;
    } else if let Some(file_id) = scenario.strip_prefix("跨会话附件验证 ") {
        let media = PathBuf::from(
            std::env::var_os("RUST_IM_FIXTURE_MEDIA").context("missing media folder")?,
        );
        let output = media.join("cross-conversation.pdf");
        let result = call(
            "attachment.download",
            json!({"fileId":file_id,"path":output}),
        )?;
        assert_eq!(result["error"]["status"], 404, "{result}");
        assert!(!output.exists());
        assert_eq!(
            call(
                "message.send",
                json!({
                    "clientId":format!("fixture-denied-{}", message["id"].as_str().unwrap()),
                    "text":"跨会话读取已拒绝",
                })
            )?["result"]["text"],
            "跨会话读取已拒绝",
        );
    }
    if matches!(
        scenario,
        "启动 Rust 流式回复" | "等待用户取消" | "Agent 自行取消" | "模拟流式失败"
    ) {
        let cid = format!("fixture-stream-{}", message["id"].as_str().unwrap());
        let initial = json!({
            "clientId":cid,"text":"","options":{
                "state":"streaming","replyTo":message["id"],"mentions":[message["senderId"]],
            }
        });
        let reply = call("message.send", initial.clone())?;
        assert!(reply["error"].is_null(), "{reply}");
        let stream = &reply["result"];
        let id = &stream["id"];
        if stream["state"] == "streaming" {
            if scenario == "Agent 自行取消" {
                assert_eq!(
                    call("message.cancel", json!({"messageId":id}))?["result"]["state"],
                    "cancelled"
                );
            } else if scenario == "模拟流式失败" {
                assert_eq!(
                    call(
                        "message.update",
                        json!({"messageId":id,"revision":1,"text":"Rust 失败","state":"failed"})
                    )?["result"]["state"],
                    "failed"
                );
            } else {
                let partial = json!({
                    "messageId":id,"revision":1,"text":"Rust 部分回复 🔒",
                    "activities":[{"kind":"search","status":"in_progress"}]
                });
                if stream["revision"] == 0 {
                    assert_eq!(
                        call("message.update", partial.clone())?["result"]["revision"],
                        1
                    );
                }
                assert_eq!(
                    call("message.update", partial.clone())?["result"]["revision"],
                    1
                );
                let mut conflict = partial;
                conflict["text"] = json!("不同的快照");
                assert_eq!(call("message.update", conflict)?["error"]["status"], 409);
                let cancel = scenario == "等待用户取消";
                let mut ready = false;
                for _ in 0..160 {
                    if cancel {
                        let snapshot = call("message.read", json!({"messageId":id}))?;
                        if snapshot["result"]["state"] == "cancelled" {
                            assert_eq!(snapshot["result"]["text"], "Rust 部分回复 🔒");
                            ready = true;
                            break;
                        }
                    } else {
                        let history = call("message.history", json!({}))?;
                        if history["result"]["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|item| {
                                item["text"] == "继续流式回复"
                                    && item["senderId"] == message["senderId"]
                            })
                        {
                            ready = true;
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                ensure!(ready, "fixture stream did not receive user action");
                let result = call(
                    "message.update",
                    json!({
                        "messageId":id,"revision":if cancel { 3 } else { 2 },"text":"Rust 完整回复 🔒","state":"complete"
                    }),
                )?;
                if cancel {
                    assert_eq!(result["error"]["status"], 409);
                } else {
                    assert_eq!(result["result"]["state"], "complete");
                    assert_eq!(result["result"]["activities"][0]["status"], "in_progress");
                }
            }
        }
        let replay = call("message.send", initial.clone())?;
        assert_eq!(&replay["result"]["id"], id);
        assert_ne!(replay["result"]["state"], "streaming");
        let mut different = initial;
        different["text"] = json!("不同的请求");
        assert_eq!(call("message.send", different)?["error"]["status"], 409);
    }
    assert_eq!(call("done", Value::Null)?["result"]["ok"], true);
    Ok(())
}

fn send_cards(
    call: &mut impl FnMut(&str, Value) -> Result<Value>,
    message: &Value,
    scenario: &str,
) -> Result<()> {
    let id = message["id"].as_str().unwrap();
    let cards: &[(&str, &str)] = if scenario == "验证旧版卡片" {
        &[("legacy", "旧 Node 审批")]
    } else {
        &[
            ("allow", "Rust 允许审批"),
            ("deny", "Rust 拒绝审批"),
            ("question", "Rust 组合提问"),
            ("cancel", "Rust 撤销审批"),
        ]
    };
    for (kind, title) in cards {
        let mut interaction = json!({
            "kind":"approval","recipientId":message["senderId"],
            "title":format!("  {title}  "),"description":"  私密说明 · only recipients 🔒  ",
        });
        if *kind == "question" {
            interaction["kind"] = json!("question");
            interaction["questions"] = json!([
                {"id":"single","question":"  单选问题  ","options":[{"label":" A "},{"label":"B"}]},
                {"id":"multiple","question":"多选问题","multiSelect":true,"detail":"仅成员可见",
                    "options":[{"label":"甲","description":"第一项"},{"label":"乙"}]},
                {"id":"text","question":"开放提问"},
            ]);
        }
        if *kind == "legacy" {
            interaction["expiresAt"] = json!(message["createdAt"].as_u64().unwrap() + 3_600_000);
        }
        let request = json!({
            "clientId":format!("fixture-card-{id}-{kind}"),"text":"Rust 交互卡片",
            "options":{"replyTo":id,"interaction":interaction}
        });
        let sent = call("message.send", request.clone())?;
        assert!(sent["error"].is_null(), "{sent}");
        let card = &sent["result"];
        assert_eq!(card["interaction"]["title"], *title);
        let replay = call("message.send", request.clone())?;
        assert_eq!(replay["result"]["id"], card["id"]);
        let mut conflict = request;
        conflict["options"]["interaction"]["title"] = json!("另一个标题");
        assert_eq!(call("message.send", conflict)?["error"]["status"], 409);
        if *kind == "cancel" {
            for _ in 0..2 {
                let result = call("interaction.cancel", json!({"messageId":card["id"]}))?;
                assert_eq!(
                    result["result"]["interaction"]["status"], "cancelled",
                    "{result}"
                );
            }
        }
    }
    Ok(())
}

fn receive_card(
    call: &mut impl FnMut(&str, Value) -> Result<Value>,
    message: &Value,
) -> Result<()> {
    let card = &message["interaction"];
    let id = message["id"].as_str().unwrap();
    let read = call("message.read", json!({"messageId":id}))?;
    assert_eq!(&read["result"]["interaction"], card);
    match card["status"].as_str() {
        Some("approved") => {
            assert_eq!(card["response"]["decision"], "approve");
            assert_eq!(card["response"]["comment"], "允许 · 私密备注");
        }
        Some("rejected") => {
            assert_eq!(card["response"]["decision"], "reject");
            assert_eq!(card["response"]["comment"], "拒绝 · 私密备注");
        }
        Some("answered") => assert_eq!(
            card["response"]["answers"],
            json!({
                "single":["A"],"multiple":["甲","乙"],"text":["只在签名密文里"]
            })
        ),
        Some("cancelled") => assert!(card["response"].is_null()),
        _ => anyhow::bail!("unexpected card notification"),
    }
    let sent = call(
        "message.send",
        json!({
            "clientId":format!("fixture-card-ack-{id}"), "text":format!("已读取 {}", card["status"].as_str().unwrap()),
            "options":{"replyTo":id}
        }),
    )?;
    assert!(sent["error"].is_null(), "{sent}");
    Ok(())
}

async fn calls(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut session = None;
    loop {
        let mut header = String::new();
        if input.read_line(&mut header)? == 0 {
            break;
        }
        let length = header
            .trim_end()
            .strip_prefix("Content-Length: ")
            .context("fixture frame")?
            .parse()?;
        let mut separator = [0; 2];
        input.read_exact(&mut separator)?;
        assert_eq!(&separator, b"\r\n");
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let request: Value = serde_json::from_slice(&bytes)?;
        let params = &request["params"];
        let result = match request["method"].as_str().expect("fixture method") {
            "call/check" => json!({"sdk":1,"audio":true,"video":true}),
            "call/open" => {
                ensure!(session.is_none(), "fixture session still open");
                session = Some(Session::open(params).await?);
                json!({"accepted":true})
            }
            "call/signal" => {
                session
                    .as_mut()
                    .context("missing call session")?
                    .signal(&params["signal"])
                    .await?
            }
            "call/poll" => session.as_ref().context("missing call session")?.poll(),
            "call/close" => {
                if let Some(session) = session.take() {
                    session.peer.close().await?;
                }
                json!({})
            }
            _ => anyhow::bail!("unknown fixture method"),
        };
        let bytes = serde_json::to_vec(&json!({
            "jsonrpc":"2.0","id":request["id"],"generation":params["generation"],"result":result
        }))?;
        write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
        output.write_all(&bytes)?;
        output.flush()?;
    }
    if let Some(session) = session {
        session.peer.close().await?;
    }
    Ok(())
}

struct Session {
    peer: Arc<dyn PeerConnection>,
    state: watch::Receiver<RTCPeerConnectionState>,
    gathered: watch::Receiver<bool>,
}

impl Session {
    async fn open(params: &Value) -> Result<Self> {
        let mut media = MediaEngine::default();
        let mut tracks: Vec<Arc<dyn TrackLocal>> = Vec::new();
        let mut add = |kind, mime: &str, rate, channels, payload_type| -> Result<()> {
            let codec = RTCRtpCodec {
                mime_type: mime.into(),
                clock_rate: rate,
                channels,
                ..Default::default()
            };
            media.register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: codec.clone(),
                    payload_type,
                    ..Default::default()
                },
                kind,
            )?;
            let track = MediaStreamTrack::new(
                "fixture-stream".into(),
                mime.into(),
                mime.into(),
                kind,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(rand::random()),
                        ..Default::default()
                    },
                    codec,
                    ..Default::default()
                }],
            );
            tracks.push(Arc::new(TrackLocalStaticRTP::new(track)));
            Ok(())
        };
        add(RtpCodecKind::Audio, "audio/opus", 48000, 2, 111)?;
        if params["call"]["mode"] == "video" {
            add(RtpCodecKind::Video, "video/VP8", 90000, 0, 96)?;
        }
        let ice = params["iceServers"]
            .as_array()
            .context("missing ICE configuration")?
            .iter()
            .map(|entry| -> Result<RTCIceServer> {
                Ok(RTCIceServer {
                    urls: serde_json::from_value(entry["urls"].clone())?,
                    username: entry["username"].as_str().unwrap_or_default().to_owned(),
                    credential: entry["credential"].as_str().unwrap_or_default().to_owned(),
                })
            })
            .collect::<Result<_>>()?;
        let (state, updates) = watch::channel(RTCPeerConnectionState::New);
        let (gathering, gathered) = watch::channel(false);
        let peer: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(RTCConfigurationBuilder::new().with_ice_servers(ice).build())
                .with_handler(Arc::new(Reflect {
                    tracks: tracks.clone(),
                    state,
                    gathering,
                }))
                .with_media_engine(media)
                .with_udp_addrs(vec!["0.0.0.0:0".to_owned(), "[::]:0".to_owned()])
                .build()
                .await?,
        );
        for track in tracks {
            peer.add_track(track).await?;
        }
        Ok(Self {
            peer,
            state: updates,
            gathered,
        })
    }

    async fn signal(&mut self, signal: &Value) -> Result<Value> {
        if signal["type"] == "candidate" {
            self.peer
                .add_ice_candidate(serde_json::from_value(signal["candidate"].clone())?)
                .await?;
            return Ok(json!({}));
        }
        let sdp = signal["description"]["sdp"]
            .as_str()
            .context("missing offer SDP")?;
        self.peer
            .set_remote_description(RTCSessionDescription::offer(sdp.to_owned())?)
            .await?;
        self.peer
            .set_local_description(self.peer.create_answer(None).await?)
            .await?;
        let _ = timeout(Duration::from_secs(3), self.gathered.wait_for(|done| *done)).await;
        let answer = self
            .peer
            .local_description()
            .await
            .context("missing answer SDP")?;
        Ok(
            json!({"signals":[{"type":"description","description":{"type":"answer","sdp":answer.sdp}}]}),
        )
    }

    fn poll(&self) -> Value {
        let state = *self.state.borrow();
        json!({
            "connected":state == RTCPeerConnectionState::Connected,
            "failed":matches!(state, RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed)
        })
    }
}

struct Reflect {
    tracks: Vec<Arc<dyn TrackLocal>>,
    state: watch::Sender<RTCPeerConnectionState>,
    gathering: watch::Sender<bool>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Reflect {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathering.send_replace(true);
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.state.send_replace(state);
    }

    async fn on_track(&self, remote: Arc<dyn TrackRemote>) {
        let tracks = self.tracks.clone();
        tokio::spawn(async move {
            for local in tracks {
                if local.kind().await != remote.kind().await {
                    continue;
                }
                let Some(&ssrc) = local.ssrcs().await.first() else {
                    return;
                };
                while let Some(event) = remote.poll().await {
                    if let TrackRemoteEvent::OnRtpPacket(mut packet) = event {
                        packet.header.ssrc = ssrc;
                        if local.write_rtp(packet).await.is_err() {
                            break;
                        }
                    }
                }
                break;
            }
        });
    }
}
