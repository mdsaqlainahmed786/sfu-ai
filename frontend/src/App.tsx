import React, { useRef, useState, useEffect } from "react";
import { Device } from "mediasoup-client";
import "./App.css";

interface RemoteVideoProps {
  stream: MediaStream;
}

function RemoteVideo({ stream }: RemoteVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      controls={false}
      style={{
        width: "300px",
        height: "200px",
        border: "1px solid #ccc",
        margin: "5px",
      }}
      // Don't set src, only srcObject!
    />
  );
}

function App() {
  const WS_URL = "ws://localhost:3000"; // adjust as needed

  const localVideoRef = useRef<HTMLVideoElement>(null);

  // Holds { peerId, stream } objects for each remote peer
  const [remoteStreams, setRemoteStreams] = useState<
    { peerId: string; stream: MediaStream }[]
  >([]);

  // Internal refs for signaling/mediasoup state across rerenders
  const wsRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<any>(null); // mediasoup-client types
  const recvTransportRef = useRef<any>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Mutable for quick stream lookup by peerId
  const remoteStreamsMap = useRef<Record<string, MediaStream>>({});

  const start = async () => {
    const ws = new window.WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = async (evt: MessageEvent) => {
      let msg: any;
      try {
        msg = typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
      } catch (err) {
        console.error("Could not parse message:", evt.data, err);
        return;
      }

      // 0: joined room
      if (msg.action === "roomJoined") {
        ws.send(JSON.stringify({ action: "getRouterRtpCapabilities" }));
      }

      // 1: got router rtp caps
      if (msg.action === "routerRtpCapabilities") {
        const device = new Device();
        await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
        deviceRef.current = device;
        ws.send(JSON.stringify({ action: "createSendTransport" }));
      }

      // 2: send transport
      if (msg.action === "createSendTransport") {
        const device = deviceRef.current;
        if (!device) {
          console.error("Device is not initialized");
          return;
        }
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
          ws.addEventListener("message", (e) => {
            try {
              const m = JSON.parse(e.data);
              if (
                m.action === "transportConnected" &&
                m.id === sendTransport.id
              ) {
                callback();
              }
            } catch {
              console.error("Error handling transport connection:", e.data);
            }
          });
        });

        sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
          ws.send(
            JSON.stringify({
              action: "produce",
              kind,
              rtpParameters,
            })
          );
          ws.addEventListener("message", (e) => {
            try {
              const m = JSON.parse(e.data);
              if (m.action === "produced") {
                callback({ id: m.id });
              }
            } catch {
              console.error("Error handling produce:", e.data);
            }
          });
        });

        // Start local media
        try {
          const localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
          localStreamRef.current = localStream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStream;
          }
          await sendTransport.produce({
            track: localStream.getVideoTracks()[0],
          });
          await sendTransport.produce({
            track: localStream.getAudioTracks()[0],
          });
        } catch (err) {
          console.error("Error getting user media:", err);
        }

        ws.send(JSON.stringify({ action: "createRecvTransport" }));
      }

      // 3: recv transport
      if (msg.action === "createRecvTransport") {
        const device = deviceRef.current;
        if (!device) {
          console.error("Device is not initialized");
          return;
        }
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
          ws.addEventListener("message", (e) => {
            try {
              const m = JSON.parse(e.data);
              if (
                m.action === "transportConnected" &&
                m.id === recvTransport.id
              ) {
                callback();
              }
            } catch {
              console.error("Error handling transport connection:", e.data);
            }
          });
        });

        ws.send(
          JSON.stringify({
            action: "consume",
            rtpCapabilities: device.rtpCapabilities,
          })
        );
      }

      // 4: consuming
      if (msg.action === "consuming") {
        const recvTransport = recvTransportRef.current;
        const consumer = await recvTransport.consume({
          id: msg.params.id,
          producerId: msg.params.producerId,
          kind: msg.params.kind,
          rtpParameters: msg.params.rtpParameters,
        });

        // Create or update the remote stream for this peer
        const peerId = msg.params.ownerPeerId;
        let stream = remoteStreamsMap.current[peerId];
        if (!stream) {
          stream = new window.MediaStream();
          remoteStreamsMap.current[peerId] = stream;
        }
        stream.addTrack(consumer.track);

        setRemoteStreams((prev) => {
          const idx = prev.findIndex((x) => x.peerId === peerId);
          if (idx === -1) {
            return [...prev, { peerId, stream }];
          } else {
            // update for new track
            const arr = [...prev];
            arr[idx] = { peerId, stream };
            return arr;
          }
        });
      }

      // 5: new producer appeared (new peer or new published track)
      if (msg.action === "newProducer") {
        const device = deviceRef.current;
        const recvTransport = recvTransportRef.current;
        if (recvTransport && device) {
          ws.send(
            JSON.stringify({
              action: "consume",
              rtpCapabilities: device.rtpCapabilities,
            })
          );
        }
      }

      // Handle remote peer disconnect
      if (msg.action === "peerDisconnected") {
        const peerId = msg.peerId;

        // Stop tracks to release resources
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

  // Cleanup WebSocket, all tracks, etc. when unmounting
  useEffect(
    () => () => {
      if (wsRef.current) wsRef.current.close();
      Object.values(remoteStreamsMap.current).forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop())
      );
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    },
    []
  );

  return (
    <div>
      <h1>SFU Demo</h1>
      <button onClick={start}>Start</button>
      <h2>Local Video</h2>
      <video ref={localVideoRef} autoPlay muted playsInline />
      <h2>Remote Videos</h2>
      <div style={{ display: "flex", flexWrap: "wrap" }}>
        {remoteStreams.map(({ peerId, stream }) => (
          <RemoteVideo key={peerId} stream={stream} />
        ))}
      </div>
    </div>
  );
}

export default App;
