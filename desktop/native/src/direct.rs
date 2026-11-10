use crate::{
    device::Backends,
    gateway::{self, Database, Lane},
    state::Route,
};
use anyhow::{Context, Result, ensure};
use bytes::BytesMut;
use libp2p_identity::{Keypair, PeerId};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::{Semaphore, watch},
    time::timeout,
};
use uuid::Uuid;
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
        RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState, RTCSessionDescription,
    },
};

#[derive(Clone)]
pub struct Direct {
    pub stun: Vec<String>,
    slots: Arc<Semaphore>,
}

impl Direct {
    pub fn new(stun: Vec<String>) -> Self {
        Self {
            stun,
            slots: Arc::new(Semaphore::new(24)),
        }
    }

    pub async fn answer(
        &self,
        sdp: String,
        db: Database,
        peer: PeerId,
        ticket: String,
        session: Uuid,
        backends: Backends,
    ) -> Result<(Arc<dyn PeerConnection>, String)> {
        ensure!(sdp.len() <= 48 * 1024, "WebRTC offer 过大");
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .context("直连数已达上限")?;
        let identity = db.lock().expect("database mutex poisoned").identity.clone();
        let (state, mut updates) = watch::channel(RTCPeerConnectionState::New);
        let (gathering, mut gathered) = watch::channel(false);
        let handler = Arc::new(Handler {
            db,
            identity,
            session,
            backends,
            route: Route {
                ticket,
                expires: i64::MAX,
                peer_id: Some(peer.to_string()),
            },
            state,
            gathering,
            lanes: Arc::new(AtomicU8::new(0)),
        });
        let config = RTCConfigurationBuilder::new()
            .with_ice_servers(
                self.stun
                    .iter()
                    .map(|url| RTCIceServer {
                        urls: vec![url.clone()],
                        ..Default::default()
                    })
                    .collect(),
            )
            .build();
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(config)
                .with_handler(handler)
                .with_udp_addrs(vec!["0.0.0.0:0".to_owned(), "[::]:0".to_owned()])
                .with_data_channel_send_buffer_limit(512 * 1024)
                .build()
                .await?,
        );
        let negotiation = async {
            pc.set_remote_description(RTCSessionDescription::offer(sdp)?)
                .await?;
            pc.set_local_description(pc.create_answer(None).await?)
                .await?;
            let _ = timeout(Duration::from_secs(3), gathered.wait_for(|done| *done)).await;
            Ok::<_, anyhow::Error>(
                pc.local_description()
                    .await
                    .context("WebRTC 未生成 answer")?
                    .sdp,
            )
        };
        let answer = match timeout(Duration::from_secs(8), negotiation).await {
            Ok(Ok(answer)) => answer,
            _ => {
                let _ = pc.close().await;
                anyhow::bail!("WebRTC 协商失败");
            }
        };
        let connection = pc.clone();
        tokio::spawn(async move {
            let _slot = slot;
            loop {
                let state = *updates.borrow_and_update();
                let deadline = match state {
                    RTCPeerConnectionState::Connected => None,
                    RTCPeerConnectionState::Disconnected => Some(Duration::from_secs(8)),
                    RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed => break,
                    _ => Some(Duration::from_secs(20)),
                };
                let changed = if let Some(duration) = deadline {
                    timeout(duration, updates.changed())
                        .await
                        .is_ok_and(|result| result.is_ok())
                } else {
                    updates.changed().await.is_ok()
                };
                if !changed {
                    break;
                }
            }
            let _ = connection.close().await;
        });
        Ok((pc, answer))
    }
}

pub async fn candidate(pc: &dyn PeerConnection, value: Value) -> Result<()> {
    if !value.is_null() {
        let candidate = serde_json::from_value(value)?;
        timeout(Duration::from_secs(5), pc.add_ice_candidate(candidate)).await??;
    }
    Ok(())
}

struct Handler {
    db: Database,
    identity: Keypair,
    route: Route,
    session: Uuid,
    backends: Backends,
    state: watch::Sender<RTCPeerConnectionState>,
    gathering: watch::Sender<bool>,
    lanes: Arc<AtomicU8>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathering.send_replace(true);
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.state.send_replace(state);
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        // The WebRTC driver awaits this callback. Never await driver operations in it.
        let db = self.db.clone();
        let identity = self.identity.clone();
        let route = self.route.clone();
        let session = self.session;
        let backends = self.backends.clone();
        let lanes = self.lanes.clone();
        tokio::spawn(async move {
            let result = async {
                let (lane, bit) = match channel.label().await?.as_str() {
                    "pocket-control-v2" => (Lane::Control, 1),
                    "pocket-bulk-v2" => (Lane::Bulk, 2),
                    _ => anyhow::bail!("WebRTC 通道名称无效"),
                };
                ensure!(channel.ordered().await? && channel.max_packet_life_time().await?.is_none()
                    && channel.max_retransmits().await?.is_none(), "WebRTC 通道必须可靠有序");
                ensure!(lanes.fetch_or(bit, Ordering::AcqRel) & bit == 0, "WebRTC 通道重复");
                let (wire, transport) = tokio::io::duplex(128 * 1024);
                tokio::select! {
                    result = relay_bytes(&channel, wire) => result,
                    result = gateway::direct_serve(transport, route, db, identity, lane, backends, session) => result,
                }
            }.await;
            let _ = result;
            let _ = channel.close().await;
        });
    }
}

async fn relay_bytes(channel: &Arc<dyn DataChannel>, wire: DuplexStream) -> Result<()> {
    let (mut from_session, mut to_session) = tokio::io::split(wire);
    let inbound = async {
        while let Some(event) = channel.poll().await {
            match event {
                DataChannelEvent::OnMessage(message) => {
                    ensure!(
                        !message.is_string && message.data.len() <= 65_536,
                        "WebRTC 帧无效"
                    );
                    to_session.write_all(&message.data).await?;
                }
                DataChannelEvent::OnClose | DataChannelEvent::OnError => break,
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    let outbound = async {
        let mut bytes = vec![0; 16 * 1024];
        while let n @ 1.. = from_session.read(&mut bytes).await? {
            timeout(
                Duration::from_secs(15),
                channel.send(BytesMut::from(&bytes[..n])),
            )
            .await??;
        }
        Ok::<_, anyhow::Error>(())
    };
    tokio::select! { result = inbound => result, result = outbound => result }
}
