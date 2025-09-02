import { Device } from "mediasoup-client";

const WS_URL = "ws://localhost:3000";

let ws: WebSocket;
let device: Device;
let sendTransport: any;
let recvTransport: any;
let localStream: MediaStream;

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteContainer = document.getElementById("remoteContainer") as HTMLDivElement;

// Store remote streams per peer
const remoteStreams: Record<string, MediaStream> = {};
function ensureRemoteVideoEl(ownerPeerId: string) {
  if (!remoteStreams[ownerPeerId]) {
    remoteStreams[ownerPeerId] = new MediaStream();
    const el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = remoteStreams[ownerPeerId];
    remoteContainer.appendChild(el);
    console.log(`🎥 Created <video> for remote peer ${ownerPeerId}`);
  }
}

(document.getElementById("startBtn") as HTMLButtonElement).onclick = start;

async function start() {
  ws = new WebSocket(WS_URL);

  // Attach onmessage BEFORE sending anything
  ws.onmessage = async (evt) => {
    let msg: any;
    try {
      msg = typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
    } catch (err) {
      console.error("❌ Could not parse message:", evt.data, err);
      return;
    }

    console.log("📩 Server →", msg);

    // Step 0: room ack
    if (msg.action === "roomJoined") {
      console.log(`✅ Joined room ${msg.roomId}, now requesting router RTP caps`);
      ws.send(JSON.stringify({ action: "getRouterRtpCapabilities" }));
    }

    // Step 1: router caps
    if (msg.action === "routerRtpCapabilities") {
      device = new Device();
      await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
      console.log("✅ Device loaded, requesting SEND transport");
      ws.send(JSON.stringify({ action: "createSendTransport" }));
    }

    // Step 2: send transport
    if (msg.action === "createSendTransport") {
      console.log("✅ Got send transport params");
      sendTransport = device.createSendTransport(msg.params);

      sendTransport.on("connect", ({ dtlsParameters }: any, callback: any) => {
        console.log("🔗 sendTransport connecting …");
        ws.send(JSON.stringify({ action: "connectTransport", id: sendTransport.id, dtlsParameters }));
        ws.addEventListener("message", (e: MessageEvent) => {
          try {
            const m = JSON.parse(e.data);
            if (m.action === "transportConnected" && m.id === sendTransport.id) {
              console.log("✅ sendTransport connected");
              callback();
            }
          } catch {}
        });
      });

      sendTransport.on("produce", ({ kind, rtpParameters }: any, callback: any) => {
        console.log(`📤 Producing ${kind}`);
        ws.send(JSON.stringify({ action: "produce", kind, rtpParameters }));
        ws.addEventListener("message", (e: MessageEvent) => {
          try {
            const m = JSON.parse(e.data);
            if (m.action === "produced") {
              console.log(`✅ Server acknowledged producer ${m.id}`);
              callback({ id: m.id });
            }
          } catch {}
        });
      });

      // Start local media
      console.log("🎥 Requesting local media …");
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log("✅ Got local stream", localStream);
        localVideo.srcObject = localStream;

        await sendTransport.produce({ track: localStream.getVideoTracks()[0] });
        await sendTransport.produce({ track: localStream.getAudioTracks()[0] });
      } catch (err) {
        console.error("❌ Error getting user media:", err);
      }

      ws.send(JSON.stringify({ action: "createRecvTransport" }));
    }

    // Step 3: recv transport
    if (msg.action === "createRecvTransport") {
      console.log("✅ Got recv transport params");
      recvTransport = device.createRecvTransport(msg.params);

      recvTransport.on("connect", ({ dtlsParameters }: any, callback: any) => {
        console.log("🔗 recvTransport connecting …");
        ws.send(JSON.stringify({ action: "connectTransport", id: recvTransport.id, dtlsParameters }));
        ws.addEventListener("message", (e: MessageEvent) => {
          try {
            const m = JSON.parse(e.data);
            if (m.action === "transportConnected" && m.id === recvTransport.id) {
              console.log("✅ recvTransport connected");
              callback();
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify({ action: "consume", rtpCapabilities: device.rtpCapabilities }));
    }

    // Step 4: consuming
    if (msg.action === "consuming") {
      console.log("📩 Consuming track", msg.params);
      const consumer = await recvTransport.consume({
        id: msg.params.id,
        producerId: msg.params.producerId,
        kind: msg.params.kind,
        rtpParameters: msg.params.rtpParameters
      });
      ensureRemoteVideoEl(msg.params.ownerPeerId);
      remoteStreams[msg.params.ownerPeerId].addTrack(consumer.track);
    }

    // Step 5: new producer appeared
    if (msg.action === "newProducer") {
      console.log("📩 New producer appeared", msg);
      if (recvTransport && device) {
        ws.send(JSON.stringify({ action: "consume", rtpCapabilities: device.rtpCapabilities }));
      }
    }
  };

  // Now open connection
  ws.onopen = () => {
    const url = new URL(window.location.href);
    const roomId = url.searchParams.get("roomid") || "default";
    console.log("🔎 Joining room", roomId);
    ws.send(JSON.stringify({ action: "joinRoom", roomId }));
  };
}
