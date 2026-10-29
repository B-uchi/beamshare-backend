import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

/* -----------------------------------------------------------
   Hop signaling server

   Introduces browsers to each other so they can open direct
   WebRTC data channels. File contents never pass through here.
------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 8080;
const JWT_SECRET = process.env.JWT_SECRET;
const GRACE_MS = Number(process.env.GRACE_MS) || 30_000;
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 16;
const HEARTBEAT_MS = 25_000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (!JWT_SECRET) {
  console.error("JWT_SECRET is required (must match the frontend).");
  process.exit(1);
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/*
rooms: Map<code, {
  code, hostId, locked, createdAt,
  members: Map<id, { id, key, name, role, socket, online, joinedAt, graceTimer }>
}>
*/
const rooms = new Map();

/* -----------------------------------------------------------
   HTTP (health check) + WebSocket upgrade
------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) })
    );
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024,
  verifyClient: ({ origin, req }, done) => {
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
      return done(false, 403, "Origin not allowed");
    }
    const token = new URL(req.url, "http://localhost").searchParams.get("token");
    if (!token) return done(false, 401, "Missing token");
    try {
      jwt.verify(token, JWT_SECRET, { clockTolerance: 30 });
      done(true);
    } catch {
      done(false, 401, "Invalid token");
    }
  },
});

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.meta = null; // { code, memberId } once in a room
  socket.bucket = { tokens: RATE_BURST, last: Date.now() };

  socket.on("pong", () => (socket.isAlive = true));
  socket.on("message", (raw, isBinary) => {
    socket.isAlive = true;
    if (isBinary || !takeToken(socket)) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(socket, "invalid", "Malformed message");
    }
    if (!msg || typeof msg.t !== "string") return;

    try {
      handle(socket, msg);
    } catch (err) {
      console.error("Handler error:", msg.t, err);
      sendError(socket, "internal", "Something went wrong");
    }
  });
  socket.on("close", () => detach(socket));
  socket.on("error", (err) => console.warn("Socket error:", err.message));

  send(socket, { t: "hello", graceMs: GRACE_MS, maxMembers: MAX_MEMBERS });
});

// Server-side heartbeat: terminate sockets that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

/* -----------------------------------------------------------
   Rate limiting (token bucket per socket)
------------------------------------------------------------ */

const RATE_BURST = 120;
const RATE_PER_SEC = 40;

function takeToken(socket) {
  const now = Date.now();
  const b = socket.bucket;
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.last) / 1000) * RATE_PER_SEC);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* -----------------------------------------------------------
   Message routing
------------------------------------------------------------ */

function handle(socket, msg) {
  switch (msg.t) {
    case "ping":
      return send(socket, { t: "pong" });
    case "create":
      return handleCreate(socket, msg);
    case "join":
      return handleJoin(socket, msg);
    case "resume":
      return handleResume(socket, msg);
    case "leave":
      return handleLeave(socket);
    case "end":
      return withHost(socket, (room) => endRoom(room, "host-ended"));
    case "lock":
      return withHost(socket, (room) => {
        room.locked = Boolean(msg.locked);
        broadcastRoom(room, { kind: room.locked ? "locked" : "unlocked" });
      });
    case "kick":
      return withHost(socket, (room, self) => {
        const target = room.members.get(msg.id);
        if (!target || target.id === self.id) return;
        send(target.socket, { t: "ended", reason: "kicked" });
        if (target.socket) target.socket.meta = null;
        removeMember(room, target, "removed");
      });
    case "rename": {
      const ctx = context(socket);
      if (!ctx) return;
      const name = sanitizeName(msg.name);
      if (name === ctx.member.name) return;
      ctx.room.members.delete(ctx.member.id);
      ctx.member.name = uniqueName(ctx.room, name);
      ctx.room.members.set(ctx.member.id, ctx.member);
      return broadcastRoom(ctx.room, { kind: "renamed", id: ctx.member.id, name: ctx.member.name });
    }
    case "signal":
      return handleSignal(socket, msg);
    default:
      return sendError(socket, "invalid", `Unknown message: ${msg.t}`);
  }
}

function handleCreate(socket, { name }) {
  leaveCurrentRoom(socket);

  const room = {
    code: generateCode(),
    hostId: null,
    locked: false,
    createdAt: new Date().toISOString(),
    members: new Map(),
  };
  rooms.set(room.code, room);

  const member = addMember(room, socket, name, "host");
  room.hostId = member.id;

  console.log(`Room ${room.code} created`);
  sendJoined(socket, room, member, false);
}

function handleJoin(socket, { code, name }) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return sendError(socket, "not_found", "No room with that code");
  if (room.locked) return sendError(socket, "locked", "This room is locked by the host");
  if (room.members.size >= MAX_MEMBERS) {
    return sendError(socket, "full", `This room is full (${MAX_MEMBERS} people max)`);
  }

  leaveCurrentRoom(socket);
  const member = addMember(room, socket, name, "guest");

  sendJoined(socket, room, member, false);
  broadcastRoom(room, { kind: "joined", id: member.id, name: member.name }, member.id);
}

function handleResume(socket, { code, id, key }) {
  const room = rooms.get(normalizeCode(code));
  const member = room?.members.get(id);
  if (!room || !member || !safeEqual(member.key, key)) {
    return sendError(socket, "resume_failed", "That room is no longer available");
  }

  // A refreshed tab can resume before the server notices the old socket died.
  if (member.socket && member.socket !== socket) {
    const old = member.socket;
    old.meta = null;
    send(old, { t: "ended", reason: "replaced" });
    old.close(4000, "Replaced by a newer connection");
  }
  if (socket.meta && socket.meta.memberId !== id) leaveCurrentRoom(socket);

  clearTimeout(member.graceTimer);
  member.graceTimer = null;
  const wasOffline = !member.online;
  member.socket = socket;
  member.online = true;
  socket.meta = { code: room.code, memberId: member.id };

  sendJoined(socket, room, member, true);
  if (wasOffline) {
    broadcastRoom(room, { kind: "online", id: member.id, name: member.name }, member.id);
  }
}

function handleLeave(socket, notifySelf = true) {
  const ctx = context(socket);
  if (!ctx) return;
  socket.meta = null;
  ctx.member.socket = null;
  if (notifySelf) send(socket, { t: "ended", reason: "left" });
  if (ctx.member.role === "host") endRoom(ctx.room, "host-ended");
  else removeMember(ctx.room, ctx.member, "left");
}

function handleSignal(socket, { to, data }) {
  const ctx = context(socket);
  if (!ctx || typeof to !== "string" || !data) return;
  const target = ctx.room.members.get(to);
  if (!target?.online) return send(socket, { t: "signal-failed", to });
  send(target.socket, { t: "signal", from: ctx.member.id, data });
}

/* -----------------------------------------------------------
   Room + member lifecycle
------------------------------------------------------------ */

function addMember(room, socket, rawName, role) {
  const member = {
    id: crypto.randomUUID(),
    key: crypto.randomBytes(24).toString("base64url"),
    name: uniqueName(room, sanitizeName(rawName)),
    role,
    socket,
    online: true,
    joinedAt: new Date().toISOString(),
    graceTimer: null,
  };
  room.members.set(member.id, member);
  socket.meta = { code: room.code, memberId: member.id };
  return member;
}

function removeMember(room, member, kind) {
  clearTimeout(member.graceTimer);
  room.members.delete(member.id);
  broadcastRoom(room, { kind, id: member.id, name: member.name });
}

function endRoom(room, reason) {
  for (const member of room.members.values()) {
    clearTimeout(member.graceTimer);
    if (member.socket) {
      send(member.socket, { t: "ended", reason });
      member.socket.meta = null;
    }
  }
  rooms.delete(room.code);
  console.log(`Room ${room.code} ended (${reason})`);
}

// Socket closed: keep the seat warm for GRACE_MS so refreshes and network blips can resume.
function detach(socket) {
  const ctx = context(socket);
  socket.meta = null;
  if (!ctx || ctx.member.socket !== socket) return;

  const { room, member } = ctx;
  member.socket = null;
  member.online = false;
  member.graceTimer = setTimeout(() => {
    if (!rooms.has(room.code) || member.online) return;
    if (member.role === "host") endRoom(room, "host-timeout");
    else removeMember(room, member, "left");
  }, GRACE_MS);

  broadcastRoom(room, { kind: "offline", id: member.id, name: member.name });
}

// Switching rooms on the same connection: leave quietly so the socket isn't told it "ended".
function leaveCurrentRoom(socket) {
  if (socket.meta) handleLeave(socket, false);
}

function withHost(socket, fn) {
  const ctx = context(socket);
  if (!ctx) return sendError(socket, "not_in_room", "You are not in a room");
  if (ctx.member.role !== "host") return sendError(socket, "not_host", "Only the host can do that");
  fn(ctx.room, ctx.member);
}

function context(socket) {
  if (!socket.meta) return null;
  const room = rooms.get(socket.meta.code);
  const member = room?.members.get(socket.meta.memberId);
  return room && member ? { room, member } : null;
}

/* -----------------------------------------------------------
   Outbound
------------------------------------------------------------ */

function snapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    locked: room.locked,
    createdAt: room.createdAt,
    members: [...room.members.values()].map(({ id, name, role, online, joinedAt }) => ({
      id,
      name,
      role,
      online,
      joinedAt,
    })),
  };
}

function sendJoined(socket, room, member, resumed) {
  send(socket, {
    t: "joined",
    resumed,
    self: { id: member.id, key: member.key },
    room: snapshot(room),
  });
}

// Every membership change ships the full roster, so clients can never drift out of sync.
function broadcastRoom(room, event, exceptId) {
  const payload = { t: "room", room: snapshot(room), event };
  for (const member of room.members.values()) {
    if (member.id !== exceptId) send(member.socket, payload);
  }
}

function send(socket, data) {
  if (socket?.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(data));
  } catch (err) {
    console.warn("Send failed:", err.message);
  }
}

function sendError(socket, code, message) {
  send(socket, { t: "error", code, message });
}

/* -----------------------------------------------------------
   Helpers
------------------------------------------------------------ */

function generateCode() {
  let code;
  do {
    code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function sanitizeName(name) {
  const clean = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return clean || "Guest";
}

function uniqueName(room, name) {
  const taken = new Set([...room.members.values()].map((m) => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* -----------------------------------------------------------
   Start / shutdown
------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log(`Hop signaling server listening on :${PORT}`);
});

function shutdown() {
  console.log("Shutting down…");
  for (const socket of wss.clients) socket.close(1012, "Server restarting");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
