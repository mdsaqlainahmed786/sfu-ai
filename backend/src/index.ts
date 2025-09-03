import { WebSocketServer, WebSocket } from "ws";
import * as mediasoup from "mediasoup";

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

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createWebRtcTransport(router: mediasoup.types.Router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }], // replace announcedIp in prod
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
  worker = await mediasoup.createWorker();
  console.log("SFU worker ready");

  const wss = new WebSocketServer({ port: 3000 });
  console.log("Signaling on ws://localhost:3000");

  wss.on("connection", (ws) => {
    const peer: Peer = { id: genId(), producers: [], consumers: [], ws };
    console.log(`🔎 Peer connected: ${peer.id}`);

    ws.on("message", async (buf) => {
        console.log("🔎 LOG: Raw message:", buf.toString());
      const msg = JSON.parse(buf.toString());
      // console.log("RX", peer.id, msg);

      try {
        // 0) Join a room (MUST be first)
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
          console.log(`📤 Sending roomJoined to ${peer.id} for room ${roomId}`);
          ws.send(JSON.stringify({ action: "roomJoined", roomId }));
        }

        // 1) Router RTP capabilities (scoped to room.router)
        else if (msg.action === "getRouterRtpCapabilities") {
          if (!peer.roomId) {
            console.warn(`⚠️ ${peer.id} asked caps before joinRoom`);
            return;
          }
          const room = rooms.get(peer.roomId)!;
          ws.send(JSON.stringify({
            action: "routerRtpCapabilities",
            rtpCapabilities: room.router.rtpCapabilities
          }));
        }

        // 2) Create SEND transport (room-scoped)
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

        // 3) Create RECV transport (room-scoped)
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

        // 4) Connect transport (DTLS)
        else if (msg.action === "connectTransport") {
          const t =
            peer.sendTransport?.id === msg.id ? peer.sendTransport :
            peer.recvTransport?.id === msg.id ? peer.recvTransport : undefined;

          if (!t) {
            console.error(`❌ No transport for ${peer.id} (id=${msg.id})`);
            return;
          }
          await t.connect({ dtlsParameters: msg.dtlsParameters });
          ws.send(JSON.stringify({ action: "transportConnected", id: t.id }));
        }

        // 5) Produce (publish track into THIS room)
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

          // Notify peers only in this room
          for (const [, otherPeer] of room.peers) {
            if (otherPeer.id === peer.id) continue;
            otherPeer.ws.send(JSON.stringify({
              action: "newProducer",
              ownerPeerId: peer.id,
              producerId: producer.id
            }));
          }
        }

        // 6) Consume (subscribe to others in THIS room)
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
      console.log("ROOM EXISTS:", room.id);
      console.log("Deleting peer:", peer.id);
      room.peers.delete(peer.id);
      // close this peer's stuff
      peer.producers.forEach((p) => p.close());
      peer.consumers.forEach((c) => c.close());
      peer.sendTransport?.close();
      peer.recvTransport?.close();

      // remove from room lists
      room.producers = room.producers.filter((x) => x.ownerPeerId !== peer.id);
      room.peers.delete(peer.id);

      // delete room if empty
      if (room.peers.size === 0) {
        room.router.close();
        rooms.delete(room.id);
        console.log(`🧹 Deleted empty room ${room.id}`);
      }

      // NOTIFY OTHER PEERS IN THE ROOM THAT THIS PEER DISCONNECTED
// NOTIFY OTHER PEERS FIRST, before removing from room


// THEN remove from room

    });
  });
}

boot().catch(console.error);