import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import express from "express";
import * as mediasoup from "mediasoup";
import cors from "cors";

const app = express();
app.use(cors({
  origin: ["http://localhost:5173", "https://sfu-ai.onrender.com"],
  credentials: true
}));
type Peer = {
  id: string;
  roomId?: string;
  sendTransport?: mediasoup.types.WebRtcTransport;
  recvTransport?: mediasoup.types.WebRtcTransport;
  producers: mediasoup.types.Producer[];
  consumers: mediasoup.types.Consumer[];
  ws: WebSocket;
};

type Room = {
  id: string;
  router: mediasoup.types.Router;
  peers: Map<string, Peer>;
  producers: { producer: mediasoup.types.Producer; ownerPeerId: string }[];
};

const rooms = new Map<string, Room>();
let worker: mediasoup.types.Worker;

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  // @ts-ignore
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  // @ts-ignore
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 }
];


async function getPublicIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    //@ts-ignore
    console.log("🌍 Public IP of server:", data.ip);
  } catch (err) {
    console.error("❌ Could not fetch public IP", err);
  }
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createWebRtcTransport(router: mediasoup.types.Router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
  transport.on("dtlsstatechange", (state) => {
    console.log(`🔎 transport ${transport.id} dtlsstatechange → ${state}`);
    if (state === "closed") transport.close();
  });
  return transport;
}

async function boot() {
  await getPublicIp();
  worker = await mediasoup.createWorker();
  console.log("SFU worker ready");

  const wss = new WebSocketServer({ port: Number(process.env.PORT) || 3000 });
  console.log(`Signaling on ws://localhost:${wss.options.port}`);

  wss.on("connection", (ws) => {
    const peer: Peer = { id: genId(), producers: [], consumers: [], ws };
    console.log(`🔎 Peer connected: ${peer.id}`);

    ws.on("message", async (buf) => {
      const msg = JSON.parse(buf.toString());

      try {
        // 0) Join a room
        if (msg.action === "joinRoom") {
          const roomId: string = msg.roomId;
          if (!roomId) return;

          peer.roomId = roomId;

          if (!rooms.has(roomId)) {
            const router = await worker.createRouter({ mediaCodecs });
            rooms.set(roomId, { id: roomId, router, peers: new Map(), producers: [] });
            console.log(`🔎 Created room ${roomId}`);
          }

          const room = rooms.get(roomId)!;
          room.peers.set(peer.id, peer);
          console.log(`🔎 Peer ${peer.id} joined room ${roomId}`);

          // ✅ Send list of existing producers to this peer
          const existing = room.producers.map((p) => ({
            ownerPeerId: p.ownerPeerId,
            producerId: p.producer.id,
            kind: p.producer.kind
          }));

          ws.send(JSON.stringify({ action: "roomJoined", roomId, existingProducers: existing }));
        }

        // 1) Router RTP capabilities
        else if (msg.action === "getRouterRtpCapabilities") {
          if (!peer.roomId) return;
          const room = rooms.get(peer.roomId)!;
          ws.send(JSON.stringify({
            action: "routerRtpCapabilities",
            rtpCapabilities: room.router.rtpCapabilities
          }));
        }

        // 2) Create SEND transport
        else if (msg.action === "createSendTransport") {
          if (!peer.roomId) return;
          const room = rooms.get(peer.roomId)!;
          const t = await createWebRtcTransport(room.router);
          peer.sendTransport = t;
          ws.send(JSON.stringify({
            action: "createSendTransport",
            params: {
              id: t.id,
              iceParameters: t.iceParameters,
              iceCandidates: t.iceCandidates,
              dtlsParameters: t.dtlsParameters
            }
          }));
        }

        // 3) Create RECV transport
        else if (msg.action === "createRecvTransport") {
          if (!peer.roomId) return;
          const room = rooms.get(peer.roomId)!;
          const t = await createWebRtcTransport(room.router);
          peer.recvTransport = t;
          ws.send(JSON.stringify({
            action: "createRecvTransport",
            params: {
              id: t.id,
              iceParameters: t.iceParameters,
              iceCandidates: t.iceCandidates,
              dtlsParameters: t.dtlsParameters
            }
          }));
        }

        // 4) Connect transport
        else if (msg.action === "connectTransport") {
          const t =
            peer.sendTransport?.id === msg.id ? peer.sendTransport :
              peer.recvTransport?.id === msg.id ? peer.recvTransport : undefined;

          if (!t) return;
          await t.connect({ dtlsParameters: msg.dtlsParameters });
          ws.send(JSON.stringify({ action: "transportConnected", id: t.id }));
        }

        // 5) Produce
        else if (msg.action === "produce") {
          if (!peer.roomId || !peer.sendTransport) return;
          const room = rooms.get(peer.roomId)!;

          const producer = await peer.sendTransport.produce({
            kind: msg.kind,
            rtpParameters: msg.rtpParameters
          });

          peer.producers.push(producer);
          room.producers.push({ producer, ownerPeerId: peer.id });
          ws.send(JSON.stringify({ action: "produced", id: producer.id }));

          // Notify other peers in room
          for (const [, otherPeer] of room.peers) {
            if (otherPeer.id !== peer.id) {
              otherPeer.ws.send(JSON.stringify({
                action: "newProducer",
                ownerPeerId: peer.id,
                producerId: producer.id
              }));
            }
          }
        }

        // 6) Consume
        else if (msg.action === "consume") {
          if (!peer.roomId || !peer.recvTransport) return;
          const room = rooms.get(peer.roomId)!;

          for (const { producer, ownerPeerId } of room.producers) {
            if (ownerPeerId === peer.id) continue;
            if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) continue;
            if (peer.consumers.some((c) => c.producerId === producer.id)) continue;

            const consumer = await peer.recvTransport.consume({
              producerId: producer.id,
              rtpCapabilities: msg.rtpCapabilities,
              paused: false
            });

            peer.consumers.push(consumer);

            ws.send(JSON.stringify({
              action: "consuming",
              params: {
                id: consumer.id,
                producerId: producer.id,
                ownerPeerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters
              }
            }));
          }
        }
        // End the entire room (host action)
        else if (msg.action === "endRoom") {
          const rid = peer.roomId;
          if (!rid) return;
          const room = rooms.get(rid);
          if (!room) return;

          // Notify all peers
          for (const [, otherPeer] of room.peers) {
            otherPeer.ws.send(JSON.stringify({ action: "roomEnded" }));
            otherPeer.producers.forEach((p) => p.close());
            otherPeer.consumers.forEach((c) => c.close());
            otherPeer.sendTransport?.close();
            otherPeer.recvTransport?.close();
            otherPeer.ws.close(); // force-close their WS
          }

          // Clean up router
          room.router.close();
          rooms.delete(rid);
          console.log(`🛑 Room ${rid} ended by ${peer.id}`);
        }

      } catch (err) {
        console.error("❌ Error handling message:", err);
      }

    });


    ws.on("close", () => {
      console.log(`🔎 Peer disconnected: ${peer.id}`);
      const rid = peer.roomId;
      if (!rid) return;
      const room = rooms.get(rid);
      if (!room) return;

      // Notify others
      for (const [, otherPeer] of room.peers) {
        if (otherPeer.id !== peer.id) {
          otherPeer.ws.send(JSON.stringify({
            action: "peerDisconnected",
            peerId: peer.id
          }));
        }
      }

      // Cleanup
      peer.producers.forEach((p) => p.close());
      peer.consumers.forEach((c) => c.close());
      peer.sendTransport?.close();
      peer.recvTransport?.close();

      room.producers = room.producers.filter((x) => x.ownerPeerId !== peer.id);
      room.peers.delete(peer.id);

      if (room.peers.size === 0) {
        room.router.close();
        rooms.delete(room.id);
        console.log(`🧹 Deleted empty room ${room.id}`);
      }
    });
  });
}

boot().catch(console.error);
