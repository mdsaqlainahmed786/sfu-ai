import { Device } from "mediasoup-client";

const WS_URL = "ws://localhost:3000";

let ws: WebSocket;
let device: Device;
let sendTransport: any;
let recvTransport: any;
let localStream: MediaStream;

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteContainer = document.getElementById("remoteContainer") as HTMLDivElement;

// Group all remote tracks (audio+video) per peer
const remoteStreams: Record<string, MediaStream> = {};
const ensureRemoteVideoEl = (ownerPeerId: string) => {
  if (!remoteStreams[ownerPeerId]) {
    remoteStreams[ownerPeerId] = new MediaStream();
    const el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = remoteStreams[ownerPeerId];
    remoteContainer.appendChild(el);
    console.log(`🔎 LOG: Created <video> for remote peer ${ownerPeerId}`);
  }
};

(document.getElementById("startBtn") as HTMLButtonElement).onclick = start;

async function start() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("🔎 LOG: WebSocket connected → asking for router RTP capabilities");
    ws.send(JSON.stringify({ action: "getRouterRtpCapabilities" }));
  };

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    console.log("🔎 LOG: Message from server →", msg);

    // 1) Setup Device
    if (msg.action === "routerRtpCapabilities") {
      console.log("🔎 LOG: Got router RTP caps, creating Device");
      device = new Device();
      await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
      console.log("🔎 LOG: Device loaded, requesting SEND transport");
      ws.send(JSON.stringify({ action: "createSendTransport" }));
    }

    // 2) Send transport
    if (msg.action === "createSendTransport") {
      console.log("🔎 LOG: Got send transport params → creating sendTransport");
      sendTransport = device.createSendTransport(msg.params);

      sendTransport.on("connect", ({ dtlsParameters }: any, callback: any) => {
        console.log("🔎 LOG: sendTransport.on(connect) → sending connectTransport");
        ws.send(JSON.stringify({ action: "connectTransport", id: sendTransport.id, dtlsParameters }));

        const handler = (e: MessageEvent) => {
          const m = JSON.parse(e.data);
          if (m.action === "transportConnected" && m.id === sendTransport.id) {
            console.log("🔎 LOG: sendTransport connected");
            ws.removeEventListener("message", handler);
            callback();
          }
        };
        ws.addEventListener("message", handler);
      });

      sendTransport.on("produce", ({ kind, rtpParameters }: any, callback: any) => {
        console.log(`🔎 LOG: sendTransport.on(produce) → kind=${kind}`);
        ws.send(JSON.stringify({ action: "produce", kind, rtpParameters }));

        const handler = (e: MessageEvent) => {
          const m = JSON.parse(e.data);
          if (m.action === "produced") {
            console.log("🔎 LOG: Server acknowledged producer", m.id);
            ws.removeEventListener("message", handler);
            callback({ id: m.id });
          }
        };
        ws.addEventListener("message", handler);
      });

      // Capture local media
      console.log("🔎 LOG: Calling getUserMedia for video+audio");
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      console.log("🔎 LOG: Got local stream", localStream);
      localVideo.srcObject = localStream;

      // Publish video + audio
      console.log("🔎 LOG: Producing local video");
      await sendTransport.produce({ track: localStream.getVideoTracks()[0] });
      console.log("🔎 LOG: Producing local audio");
      await sendTransport.produce({ track: localStream.getAudioTracks()[0] });

      // Now request RECV transport
      console.log("🔎 LOG: Asking for RECV transport");
      ws.send(JSON.stringify({ action: "createRecvTransport" }));
    }

    // 3) Recv transport
    if (msg.action === "createRecvTransport") {
      console.log("🔎 LOG: Got recv transport params → creating recvTransport");
      recvTransport = device.createRecvTransport(msg.params);

      recvTransport.on("connect", ({ dtlsParameters }: any, callback: any) => {
        console.log("🔎 LOG: recvTransport.on(connect) → sending connectTransport");
        ws.send(JSON.stringify({ action: "connectTransport", id: recvTransport.id, dtlsParameters }));

        const handler = (e: MessageEvent) => {
          const m = JSON.parse(e.data);
          if (m.action === "transportConnected" && m.id === recvTransport.id) {
            console.log("🔎 LOG: recvTransport connected");
            ws.removeEventListener("message", handler);
            callback();
          }
        };
        ws.addEventListener("message", handler);
      });

      // Ask to consume any existing producers
      console.log("🔎 LOG: Asking to consume available producers");
      ws.send(JSON.stringify({ action: "consume", rtpCapabilities: device.rtpCapabilities }));
    }

    // 4) Consuming
    if (msg.action === "consuming") {
      console.log("🔎 LOG: Received consuming params", msg.params);
      const consumer = await recvTransport.consume({
        id: msg.params.id,
        producerId: msg.params.producerId,
        kind: msg.params.kind,
        rtpParameters: msg.params.rtpParameters
      });
      ensureRemoteVideoEl(msg.params.ownerPeerId);
      remoteStreams[msg.params.ownerPeerId].addTrack(consumer.track);
      console.log(`🔎 LOG: Added ${msg.params.kind} track for remote peer ${msg.params.ownerPeerId}`);
    }

    // 5) New producer appeared
    if (msg.action === "newProducer") {
      console.log("🔎 LOG: New producer appeared", msg);
      if (recvTransport && device) {
        console.log("🔎 LOG: Requesting consume for new producer");
        ws.send(JSON.stringify({ action: "consume", rtpCapabilities: device.rtpCapabilities }));
      }
    }
  };
}
