import { WebSocketServer, WebSocket } from "ws";
import * as mediasoup from "mediasoup";

type Peer = {
  id: string;
  sendTransport?: mediasoup.types.WebRtcTransport;
  recvTransport?: mediasoup.types.WebRtcTransport;
  producers: mediasoup.types.Producer[];
  consumers: mediasoup.types.Consumer[];
  ws: WebSocket;
};

const peers = new Map<WebSocket, Peer>();
type ListedProducer = { producer: mediasoup.types.Producer; ownerPeerId: string };
const allProducers: ListedProducer[] = [];

let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
    //@ts-ignore
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  //@ts-ignore
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 }
];

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
  transport.on("dtlsstatechange", (state) => {
    console.log(`🔎 LOG: Transport ${transport.id} dtlsstatechange → ${state}`);
    if (state === "closed") transport.close();
  });
  //@ts-ignore
  transport.on("icecandidate", (candidate) => {
    console.log(`🔎 LOG: Transport ${transport.id} ICE candidate`, candidate);
  });
  return transport;
}

async function boot() {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs });
  console.log("SFU router ready");

  const wss = new WebSocketServer({ port: 3000 });
  console.log("Signaling on ws://localhost:3000");

  wss.on("connection", (ws) => {
    const peer: Peer = { id: genId(), producers: [], consumers: [], ws };
    peers.set(ws, peer);
    console.log(`🔎 LOG: Peer connected: ${peer.id}`);

    ws.on("message", async (buf) => {
      const msg = JSON.parse(buf.toString());
      console.log("🔎 LOG: Received from", peer.id, msg);

      try {
        // 1) Capabilities
        if (msg.action === "getRouterRtpCapabilities") {
          ws.send(JSON.stringify({
            action: "routerRtpCapabilities",
            rtpCapabilities: router.rtpCapabilities
          }));
        }

        // 2) Create send transport
        else if (msg.action === "createSendTransport") {
          console.log(`🔎 LOG: ${peer.id} creating send transport`);
          const t = await createWebRtcTransport();
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

        // 3) Create recv transport
        else if (msg.action === "createRecvTransport") {
          console.log(`🔎 LOG: ${peer.id} creating recv transport`);
          const t = await createWebRtcTransport();
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
          const transport =
            peer.sendTransport?.id === msg.id ? peer.sendTransport :
            peer.recvTransport?.id === msg.id ? peer.recvTransport : undefined;

          if (!transport) {
            console.error(`❌ ERROR: No transport found for ${peer.id} with id ${msg.id}`);
            return;
          }

          await transport.connect({ dtlsParameters: msg.dtlsParameters });
          console.log(`🔎 LOG: Transport ${transport.id} connected for ${peer.id}`);
          ws.send(JSON.stringify({ action: "transportConnected", id: transport.id }));
        }

        // 5) Produce
        else if (msg.action === "produce") {
          if (!peer.sendTransport) {
            console.error(`❌ ERROR: ${peer.id} tried to produce but has no sendTransport`);
            return;
          }
          console.log(`🔎 LOG: ${peer.id} producing kind=${msg.kind}`);

          try {
            const producer = await peer.sendTransport.produce({
              kind: msg.kind,
              rtpParameters: msg.rtpParameters
            });

            console.log(`🔎 LOG: Created producer ${producer.id} (${producer.kind}) for ${peer.id}`);

            peer.producers.push(producer);
            allProducers.push({ producer, ownerPeerId: peer.id });

            ws.send(JSON.stringify({ action: "produced", id: producer.id }));

            // Notify others
            for (const [otherWs, otherPeer] of peers) {
              if (otherPeer.id !== peer.id) {
                console.log(`🔎 LOG: Notifying ${otherPeer.id} about newProducer from ${peer.id}`);
                otherWs.send(JSON.stringify({
                  action: "newProducer",
                  ownerPeerId: peer.id,
                  producerId: producer.id
                }));
              }
            }
          } catch (err) {
            console.error(`❌ ERROR while producing for ${peer.id}`, err);
          }
        }

        // 6) Consume
        else if (msg.action === "consume") {
          if (!peer.recvTransport) {
            console.error(`❌ ERROR: ${peer.id} tried to consume but has no recvTransport`);
            return;
          }

          for (const { producer, ownerPeerId } of allProducers) {
            if (ownerPeerId === peer.id) continue;

            if (!router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) {
              console.error(`❌ ERROR: ${peer.id} cannot consume producer ${producer.id}`);
              continue;
            }

            // Skip if already consuming
            if (peer.consumers.some((c) => c.producerId === producer.id)) continue;

            try {
              const consumer = await peer.recvTransport.consume({
                producerId: producer.id,
                rtpCapabilities: msg.rtpCapabilities,
                paused: false
              });

              console.log(`🔎 LOG: ${peer.id} consuming producer ${producer.id} (${consumer.kind}) from ${ownerPeerId}`);

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
              console.log(`🔎 LOG: Sent consuming info to ${peer.id}`);
            } catch (err) {
              console.error(`❌ ERROR while consuming for ${peer.id}`, err);
            }
          }
        }
      } catch (err) {
        console.error(`❌ ERROR in message handler for ${peer.id}`, err);
      }
    });

    ws.on("close", () => {
      console.log(`🔎 LOG: Peer disconnected: ${peer.id}`);
      peer.producers.forEach((p) => {
        const idx = allProducers.findIndex((x) => x.producer.id === p.id);
        if (idx >= 0) allProducers.splice(idx, 1);
        p.close();
      });
      peer.consumers.forEach((c) => c.close());
      peer.sendTransport?.close();
      peer.recvTransport?.close();
      peers.delete(ws);
    });
  });
}

boot().catch(console.error);
