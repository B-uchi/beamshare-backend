import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_CHANGE_THIS";
const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });
const sessions = new Map();

/*
sessions = {
  [sessionId]: {
    hostId: string,
    hostSocket: WebSocket,
    peers: Map(clientId -> { name, socket }),
    offlineTimeouts: Map(clientId -> timeoutId),
    startedAt: string
  }
}
*/

// Map socket -> { clientId, sessionId }
const socketMeta = new WeakMap();

wss.on("connection", (socket, req) => {
  // --------------------------------------------
  // 1. EXTRACT AND VERIFY JWT
  // --------------------------------------------
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    socket.close(4001, "Missing token");
    return;
  }

  let verified = null;
  try {
    verified = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    socket.close(4001, "Invalid token");
    return;
  }

  // Auth passed.
  const clientId = crypto.randomUUID(); // logical client identity
  socketMeta.set(socket, { clientId, sessionId: null });

  console.log("Client connected:", clientId);

  socket.send(JSON.stringify({ type: "welcome", clientId }));

  // --------------------------------------------
  // WS MESSAGE HANDLER
  // --------------------------------------------
  socket.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    const { type } = data;

    switch (type) {
      case "create-session":
        handleCreateSession(socket, clientId);
        break;

      case "join-session":
        handleJoinSession(socket, clientId, data);
        break;

      case "destroy-session":
        handleDestroySession(data);
        break;

      case "reconnect":
        handleReconnect(socket, clientId, data);
        break;

      case "signal":
        handleSignal(socket, clientId, data);
        break;

      case "signal-answer":
        handleSignalAnswer(socket, clientId, data);
        break;

      case "signal-ice":
        handleSignalIce(socket, clientId, data);
        break;

      case "file-chunk":
        handleChunkBroadcast(socket, clientId, data);
        break;

      default:
        console.log("Unknown message type:", type);
    }
  });

  // --------------------------------------------
  // DISCONNECT HANDLER
  // --------------------------------------------
  socket.on("close", () => {
    const meta = socketMeta.get(socket);
    if (!meta) return;

    const { sessionId, clientId } = meta;
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // Determine if host or peer
    if (session.hostId === clientId) {
      // HOST DISCONNECTED
      console.log("Host disconnected:", clientId);

      // Give host a 10s reconnection window
      const timeout = setTimeout(() => {
        // Destroy session entirely
        destroySession(sessionId);
      }, 10000);

      session.offlineTimeouts.set(clientId, timeout);
    } else {
      // PEER DISCONNECTED
      console.log("Peer disconnected:", clientId);

      // Add a temporary offline timeout (just in case)
      const timeout = setTimeout(() => {
        removePeer(sessionId, clientId);
      }, 5000);

      session.offlineTimeouts.set(clientId, timeout);
    }
  });
});

wss.on("listening", () => {
  console.log("BeamShare WebSocket server running on port 8080");
});

/* -----------------------------------------------------------
   ------------------- HANDLER LOGIC --------------------------
------------------------------------------------------------ */

function safeSend(socket, data) {
  if (socket && socket.readyState === 1) { // WebSocket.OPEN
    try {
      socket.send(JSON.stringify(data));
    } catch (e) {
      console.error("Error sending to socket:", e);
    }
  }
}

function handleCreateSession(socket, clientId) {
  const sessionId = crypto.randomUUID().slice(0, 6).toUpperCase();
  const sessionStartTime = new Date().toISOString();

  sessions.set(sessionId, {
    hostId: clientId,
    hostSocket: socket,
    startedAt: sessionStartTime,
    peers: new Map(),
    offlineTimeouts: new Map(),
  });

  socketMeta.set(socket, { clientId, sessionId });

  console.log(`Session created: ${sessionId} by host: ${clientId}`);

  safeSend(socket, {
    type: "session-created",
    sessionId,
    clientId,
    startedAt: sessionStartTime,
  });
}

function handleJoinSession(socket, clientId, { sessionId, name }) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`Session not found: ${sessionId}`);
    return safeSend(socket, { type: "error", message: "Session not found" });
  }

  session.peers.set(clientId, { name, socket });
  socketMeta.set(socket, { clientId, sessionId });

  console.log(`Peer joined session ${sessionId}: ${clientId} (${name})`);

  const existingPeers = Array.from(session.peers.entries()).map(([id, { name }]) => ({
    name,
    clientId: id,
  }));

  // Inform the joining peer first
  safeSend(socket, {
    type: "joined-session",
    hostId: session.hostId,
    startedAt: session.startedAt,
    clientId,
    name,
    connectedPeers: existingPeers,
  });

  // Then inform host about the new peer (this triggers WebRTC offer creation)
  safeSend(session.hostSocket, {
    type: "peer-joined",
    clientId,
    name,
    sessionId,
  });

  // Inform other peers about the new peer
  session.peers.forEach(({ socket: peerSocket, name: peerName }, peerId) => {
    if (peerId !== clientId) {
      safeSend(peerSocket, {
        type: "peer-joined",
        clientId,
        name,
        sessionId,
      });
    }
  });
}

function handleReconnect(socket, clientId, { sessionId, name, isHost }) {
  const session = sessions.get(sessionId);
  if (!session) {
    return safeSend(socket, { type: "error", message: "Session not found" });
  }

  // Cancel any existing offline timeout
  const timeout = session.offlineTimeouts.get(clientId);
  console.log("Getting timeout for client: ", clientId)
  if (timeout) {
    clearTimeout(timeout);
    session.offlineTimeouts.delete(clientId);
    console.log("FOund and deleted timeout: ", clientId, timeout)
  }

  // Host reconnect
  if (isHost) {
    session.hostSocket = socket;
    socketMeta.set(socket, { clientId, sessionId });

    const existingPeers = Array.from(session.peers.entries()).map(([id, { name }]) => ({
      name,
      clientId: id,
    }));

    safeSend(socket, { 
      type: "reconnected-host", 
      sessionId, 
      connectedPeers: existingPeers,
      clientId 
    });

    // Notify all peers that host reconnected
    session.peers.forEach(({ socket: peerSocket }) => {
      safeSend(peerSocket, {
        type: "host-reconnected",
        hostId: clientId,
        sessionId,
      });
    });

    return;
  }

  // Peer reconnect
  session.peers.set(clientId, { name, socket });
  socketMeta.set(socket, { clientId, sessionId });

  const existingPeers = Array.from(session.peers.entries())
    // .filter(([id]) => id !== clientId)
    .map(([id, { name }]) => ({
      name,
      clientId: id,
    }));

  // Notify the reconnected peer
  safeSend(socket, {
    type: "reconnected",
    clientId,
    sessionId,
    connectedPeers: existingPeers,
    hostId: session.hostId
  });

  // Notify host about peer reconnection
  safeSend(session.hostSocket, {
    type: "peer-reconnected",
    clientId,
    name,
    sessionId,
  });

  // Notify other peers about reconnection
  session.peers.forEach(({ socket: peerSocket }, peerId) => {
    if (peerId !== clientId) {
      safeSend(peerSocket, {
        type: "peer-reconnected",
        clientId,
        name,
        sessionId,
      });
    }
  });
}

function handleSignal(socket, clientId, data) {
  const { targetId, payload, sessionId } = data;

  // console.log(`Forwarding signal offer from ${clientId} to ${targetId}`);

  // target can be host or peer
  const targetSocket = findSocketByClientId(sessionId, targetId);
  if (targetSocket) {
    safeSend(targetSocket, {
      type: "signal-offer",
      from: clientId,
      offer: payload,
    });
  } else {
    console.warn(`Target socket not found: ${targetId}`);
  }
}

function handleSignalAnswer(socket, clientId, data) {
  const { target, answer, sessionId } = data;

  // console.log(`Forwarding signal answer from ${clientId} to ${target}`);

  // target can be host or peer
  const targetSocket = findSocketByClientId(sessionId, target);
  if (targetSocket) {
    safeSend(targetSocket, {
      type: "signal-answer",
      from: clientId,
      answer,
    });
  } else {
    console.warn(`Target socket not found: ${target}`);
  }
}

function handleSignalIce(socket, clientId, data) {
  const { target, candidate, sessionId } = data;

  // console.log(`Forwarding ICE candidate from ${clientId} to ${target}`);

  // target can be host or peer
  const targetSocket = findSocketByClientId(sessionId, target);
  if (targetSocket) {
    safeSend(targetSocket, {
      type: "signal-ice",
      from: clientId,
      candidate,
    });
  } else {
    console.warn(`Target socket not found: ${target}`);
  }
}

function handleChunkBroadcast(socket, clientId, data) {
  const { sessionId, chunk, targetId } = data;

  const session = sessions.get(sessionId);
  if (!session) return;

  if (targetId === "all") {
    session.peers.forEach(({ socket: s }) => {
      if (s !== socket) {
        safeSend(s, { type: "file-chunk", from: clientId, chunk });
      }
    });
    return;
  }

  // individual peer
  const peer = session.peers.get(targetId);
  if (peer) {
    safeSend(peer.socket, { type: "file-chunk", from: clientId, chunk });
  }
}

/* -----------------------------------------------------------
   ------------------- UTILITY HELPERS ------------------------
------------------------------------------------------------ */

function findSocketByClientId(sessionId, clientId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  if (session.hostId === clientId) return session.hostSocket;

  const peer = session.peers.get(clientId);
  return peer?.socket || null;
}

function removePeer(sessionId, clientId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.peers.delete(clientId);

  // notify host
  safeSend(session.hostSocket, {
    type: "peer-left",
    clientId,
  });

  // notify other peers
  session.peers.forEach(({ socket }) => {
    safeSend(socket, {
      type: "peer-left",
      clientId,
    });
  });

  console.log(`Peer removed ${clientId} from session ${sessionId}`);
}

function destroySession(sessionId, closeSockets = true) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // notify all peers
  session.peers.forEach(({ socket }) => {
    safeSend(socket, { type: "session-ended" });
    if (closeSockets) {
      socket.close();
    }
  });

  // notify host
  if (closeSockets) {
    safeSend(session.hostSocket, { type: "session-ended" });
    session.hostSocket.close();
  }

  sessions.delete(sessionId);
  console.log("Session destroyed:", sessionId);
}

function handleDestroySession({ sessionId, clientId }) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.hostId == clientId) {
    destroySession(sessionId, false);
  }
}
