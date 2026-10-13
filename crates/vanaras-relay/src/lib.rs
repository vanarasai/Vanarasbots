use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;
use vanaras_core::{AgentEvent, Message};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
pub enum RelayPacket {
    Join { client_name: String, is_agent: bool },
    SendMessage(Message),
    SendEvent(AgentEvent),
    SyncHistory(Vec<Message>),
}

type Tx = mpsc::UnboundedSender<WsMessage>;
type PeerMap = Arc<RwLock<HashMap<Uuid, (String, Tx)>>>;

pub struct RelayServer {
    peers: PeerMap,
    history: Arc<RwLock<Vec<Message>>>,
}

impl RelayServer {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(RwLock::new(HashMap::new())),
            history: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn start(self: Arc<Self>, addr: &str) -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind(addr).await?;
        tracing::info!("Vanaras Multiplayer Relay listening on: {}", addr);

        while let Ok((stream, peer_addr)) = listener.accept().await {
            let server = Arc::clone(&self);
            tokio::spawn(server.handle_connection(stream, peer_addr));
        }

        Ok(())
    }

    async fn handle_connection(self: Arc<Self>, stream: TcpStream, addr: SocketAddr) {
        let ws_stream = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                tracing::warn!("Failed websocket handshake with {}: {:?}", addr, e);
                return;
            }
        };

        let peer_id = Uuid::new_v4();
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel();

        // Forward messages from channel to websocket client
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_sender.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Send existing history on connect
        {
            let hist = self.history.read().await;
            if !hist.is_empty() {
                let packet = RelayPacket::SyncHistory(hist.clone());
                if let Ok(json) = serde_json::to_string(&packet) {
                    let _ = tx.send(WsMessage::Text(json.into()));
                }
            }
        }

        // Register peer
        self.peers
            .write()
            .await
            .insert(peer_id, ("Anonymous".to_string(), tx.clone()));

        // Ingest incoming packets
        while let Some(Ok(msg)) = ws_receiver.next().await {
            if let WsMessage::Text(text) = msg {
                if let Ok(packet) = serde_json::from_str::<RelayPacket>(&text) {
                    match &packet {
                        RelayPacket::Join { client_name, .. } => {
                            if let Some(peer) = self.peers.write().await.get_mut(&peer_id) {
                                peer.0 = client_name.clone();
                            }
                            tracing::info!("Client joined: {}", client_name);
                        }
                        RelayPacket::SendMessage(chat_msg) => {
                            self.history.write().await.push(chat_msg.clone());
                            self.broadcast(&WsMessage::Text(text.clone()), peer_id).await;
                        }
                        RelayPacket::SendEvent(_) => {
                            self.broadcast(&WsMessage::Text(text.clone()), peer_id).await;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Cleanup
        self.peers.write().await.remove(&peer_id);
        tracing::info!("Client disconnected: {}", peer_id);
    }

    async fn broadcast(&self, msg: &WsMessage, exclude: Uuid) {
        let peers = self.peers.read().await;
        for (id, (_name, tx)) in peers.iter() {
            if *id != exclude {
                let _ = tx.send(msg.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_relay_packet_serialization() {
        let msg = Message::user("Lakshmi", "Hello Vanaras Team!");
        let packet = RelayPacket::SendMessage(msg);

        let serialized = serde_json::to_string(&packet).expect("Serialize relay packet");
        assert!(serialized.contains("send_message"));
        assert!(serialized.contains("Hello Vanaras Team!"));

        let deserialized: RelayPacket = serde_json::from_str(&serialized).expect("Deserialize relay packet");
        match deserialized {
            RelayPacket::SendMessage(m) => assert_eq!(m.sender, "Lakshmi"),
            _ => panic!("Expected SendMessage packet"),
        }
    }
}

