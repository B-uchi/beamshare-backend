# Hop — signaling server

The small WebSocket server that introduces browsers to each other so [Hop](../frontend) can open direct WebRTC data channels between them. **File contents never pass through here.**

## What it does

- **Rooms** — creates rooms with unambiguous 6-character codes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), handles join / leave / end, host-only lock, remove and rename. Up to `MAX_MEMBERS` people per room.
- **Stable identity & resume** — each member gets an `id` and a secret seat `key`. A refreshed tab or a dropped connection sends `resume { code, id, key }` and reclaims the same seat (same name, same role). Seats are held for `GRACE_MS` after a disconnect; if the host is gone longer than that, the room ends.
- **Always-in-sync roster** — every membership change broadcasts the full room snapshot (`room` message), so clients can't drift.
- **Signal relay** — forwards WebRTC offers/answers/ICE candidates (`signal { to, data }`) only between members of the same room.
- **Health** — `GET /health` returns `{ ok, rooms, uptime }` for platform health checks.
- **Hardening** — JWT checked during the WebSocket upgrade, optional `ALLOWED_ORIGINS`, ping/pong heartbeat that terminates dead sockets, per-socket rate limiting, max payload size, malformed-message tolerance, graceful shutdown.

## Setup

```bash
npm install
cp .env.example .env   # then set JWT_SECRET (must match the frontend)
npm run dev            # or: npm start
```

| Variable | Default | |
| --- | --- | --- |
| `JWT_SECRET` | — (required) | Shared with the frontend's `/api/token` route |
| `PORT` | `8080` | |
| `GRACE_MS` | `30000` | How long a disconnected seat is held |
| `MAX_MEMBERS` | `16` | People per room |
| `ALLOWED_ORIGINS` | (any) | Comma-separated list, e.g. `https://hop.example.com` |

## Protocol

Client → server: `ping`, `create {name}`, `join {code,name}`, `resume {code,id,key}`, `leave`, `end`, `lock {locked}`, `kick {id}`, `rename {name}`, `signal {to,data}`.

Server → client: `hello`, `pong`, `joined {resumed,self,room}`, `room {room,event?}`, `signal {from,data}`, `signal-failed {to}`, `ended {reason}`, `error {code,message}`.

Types live in `frontend/lib/hop/protocol.ts`.
