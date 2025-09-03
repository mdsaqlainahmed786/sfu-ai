import { useRef, useState, useEffect } from "react";
import { Device } from "mediasoup-client";
import "./App.css";
import * as mediasoupClient from "mediasoup-client";

// Types are in mediasoupClient.types
type Transport = mediasoupClient.types.Transport;
type Producer = mediasoupClient.types.Producer;

interface RemoteVideoProps {
  stream: MediaStream;
  peerId: string;
}

function RemoteVideo({ stream }: RemoteVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={{ position: "relative", display: "inline-block", margin: "5px" }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: "300px", border: "1px solid #ccc" }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "7px",
          left: "1px",
          background: "rgba(0,0,0,0.6)",
          color: "white",
          padding: "2px 6px",
          borderRadius: "4px",
          fontSize: "12px",
        }}
      >
        George Chao
      </div>
    </div>
  );
}

function App() {
const WS_URL = "wss://sfu-ai.onrender.com";

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [remoteStreams, setRemoteStreams] = useState<
    { peerId: string; stream: MediaStream }[]
  >([]);

  const wsRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<Device | null>(null);
const sendTransportRef = useRef<Transport | null>(null);
const recvTransportRef = useRef<Transport | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamsMap = useRef<Record<string, MediaStream>>({});
  const pendingProducersRef = useRef<Producer[] | null>(null);
   const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideoEnabled(videoTrack.enabled);
        console.log(`🎥 Video ${videoTrack.enabled ? "ON" : "OFF"}`);
      }
    }
  };

  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setAudioEnabled(audioTrack.enabled);
        console.log(`🎤 Audio ${audioTrack.enabled ? "ON" : "OFF"}`);
      }
    }
  };

  const start = async () => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = async (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data);
      console.log("📩 Message:", msg);

      if (msg.action === "roomJoined") {
        ws.send(JSON.stringify({ action: "getRouterRtpCapabilities" }));
        if (msg.existingProducers?.length > 0) {
          pendingProducersRef.current = msg.existingProducers;
        }
      }

      if (msg.action === "routerRtpCapabilities") {
        const device = new Device();
        await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
        deviceRef.current = device;
        ws.send(JSON.stringify({ action: "createSendTransport" }));
      }
      if (msg.action === "roomEnded") {
        console.log("🛑 Room ended by host");

        // Stop all local and remote tracks
        Object.values(remoteStreamsMap.current).forEach((s) =>
          s.getTracks().forEach((t) => t.stop())
        );
        setRemoteStreams([]);
        remoteStreamsMap.current = {};

        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((t) => t.stop());
          localStreamRef.current = null;
        }

        // Reset session so we land back on preview/home page
        sessionStorage.removeItem("joined");

        // Reload page (or switch state back to preview UI)
        window.location.reload();
      }

      if (msg.action === "createSendTransport") {
        const device = deviceRef.current!;
        const sendTransport = device.createSendTransport(msg.params);
        sendTransportRef.current = sendTransport;

        sendTransport.on("connect", ({ dtlsParameters }, callback) => {
          ws.send(
            JSON.stringify({
              action: "connectTransport",
              id: sendTransport.id,
              dtlsParameters,
            })
          );
          callback();
        });

        sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
          ws.send(JSON.stringify({ action: "produce", kind, rtpParameters }));
          ws.addEventListener("message", (e) => {
            const m = JSON.parse(e.data);
            if (m.action === "produced") callback({ id: m.id });
          });
        });

        const localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = localStream;
        if (localVideoRef.current)
          localVideoRef.current.srcObject = localStream;
        await sendTransport.produce({ track: localStream.getVideoTracks()[0] });
        await sendTransport.produce({ track: localStream.getAudioTracks()[0] });

        ws.send(JSON.stringify({ action: "createRecvTransport" }));
      }

      if (msg.action === "createRecvTransport") {
        const device = deviceRef.current!;
        const recvTransport = device.createRecvTransport(msg.params);
        recvTransportRef.current = recvTransport;

        recvTransport.on("connect", ({ dtlsParameters }, callback) => {
          ws.send(
            JSON.stringify({
              action: "connectTransport",
              id: recvTransport.id,
              dtlsParameters,
            })
          );
          callback();
        });

        // ✅ If there are existing producers, consume them now
        if (pendingProducersRef.current) {
          ws.send(
            JSON.stringify({
              action: "consume",
              rtpCapabilities: device.rtpCapabilities,
            })
          );
          pendingProducersRef.current = null;
        }
      }

      if (msg.action === "consuming") {
        const recvTransport = recvTransportRef.current!;
        const consumer = await recvTransport.consume(msg.params);
        const peerId = msg.params.ownerPeerId;
        let stream = remoteStreamsMap.current[peerId];
        if (!stream) {
          stream = new MediaStream();
          remoteStreamsMap.current[peerId] = stream;
        }
        stream.addTrack(consumer.track);
        setRemoteStreams((prev) => {
          const idx = prev.findIndex((x) => x.peerId === peerId);
          if (idx === -1) return [...prev, { peerId, stream }];
          const arr = [...prev];
          arr[idx] = { peerId, stream };
          return arr;
        });
      }

      if (msg.action === "newProducer") {
        const device = deviceRef.current!;
        ws.send(
          JSON.stringify({
            action: "consume",
            rtpCapabilities: device.rtpCapabilities,
          })
        );
      }

      if (msg.action === "peerDisconnected") {
        const peerId = msg.peerId;
        const stream = remoteStreamsMap.current[peerId];
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          delete remoteStreamsMap.current[peerId];
        }
        setRemoteStreams((prev) => prev.filter((v) => v.peerId !== peerId));
      }
    };

    ws.onopen = () => {
      const url = new URL(window.location.href);
      const roomId = url.searchParams.get("roomid") || "default";
      ws.send(JSON.stringify({ action: "joinRoom", roomId }));
    };
  };

  useEffect(() => {
    const alreadyJoined = sessionStorage.getItem("joined");
    if (alreadyJoined === "true") {
      // auto-rejoin on refresh
      start();
    }
  }, []);

  const handleStart = () => {
    sessionStorage.setItem("joined", "true");
    start();
  };

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      Object.values(remoteStreamsMap.current).forEach((s) =>
        s.getTracks().forEach((t) => t.stop())
      );
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

 return (
    <div>
      <h1>SFU Demo</h1>
      <button onClick={handleStart}>Start</button>
      <button onClick={toggleVideo}>
        {videoEnabled ? "Turn Video Off" : "Turn Video On"}
      </button>
      <button onClick={toggleAudio}>
        {audioEnabled ? "Mute" : "Unmute"}
      </button>
      <button
        onClick={() => {
          if (wsRef.current) {
            wsRef.current.send(JSON.stringify({ action: "endRoom" }));
          }
          sessionStorage.removeItem("joined");
        }}
      >
        End Call
      </button>

      <h2>Local Video</h2>
      <video ref={localVideoRef} autoPlay muted playsInline />
      <h2>Remote Videos</h2>
      <div style={{ display: "flex", flexWrap: "wrap" }}>
        {remoteStreams.map(({ peerId, stream }) => (
          <RemoteVideo key={peerId} stream={stream} peerId={peerId} />
        ))}
      </div>
    </div>
  );
}

export default App;
