# Site Chat — Realtime contract (Socket.IO → Supabase Realtime Broadcast)

Backend: `supabase/functions/api/routes/siteChat.ts` (mounted at `/site-chat`).
Every `io.to(room).emit(event, payload)` from the old `server/lib/chatSocket.js`
is now `broadcast(topic, event, payload)` on a **private** Realtime channel.

## Topics and events the client must subscribe to

| Topic | Event | Payload | Fired by | Old Socket.IO equivalent |
|---|---|---|---|---|
| `chat:group:<groupId>` | `message` | the enriched `chat_messages` row (same shape `POST /site-chat/:id` returns / `GET /site-chat/:id` lists) | `POST /site-chat/:groupId` | room `g:<gid>` event `message` |
| `chat:group:<groupId>` | `message_deleted` | `{ id }` (the deleted message id) | `DELETE /site-chat/:groupId/messages/:msgId` | (new — old code only sent `changed`) |
| `chat:group:<groupId>` | `group_deleted` | `{ groupId }` | `DELETE /site-chat/:groupId` | room `g:<gid>` event `group_deleted` |
| `user:<userId>` | `chat:changed` | `{ groupId }` | new message, `POST /:id/read`, `POST /groups`, `POST /dm`, `PUT /:id` (rename), `DELETE /:id`, `POST /:id/members`, `DELETE /:id/members/:uid`, `DELETE /:id/messages/:mid` | room `g:<gid>` event `changed` |
| `user:<userId>` | `call:signal` | `{ fromUserId, fromName, type, data }` where `type` ∈ `offer \| answer \| ice \| reject \| end \| cancel` | `POST /site-chat/calls/signal` | room `u:<uid>` events `call:offer` / `call:answer` / `call:ice` / `call:reject` / `call:end` / `call:cancel` |

### Who receives `chat:changed`
For a group `G` the backend sends one `chat:changed` to **each user in the
group's audience**: every row in `chat_group_members` for `G`, **plus every active
admin when `G` is not a DM** (this reproduces `chatSocket.roomsFor()`, where admins
joined every non-DM room). Private DMs never reach an admin who is not one of the
two participants (mam 2026-06-19). Two extra cases:

* member removed → the removed user is included (their list just changed);
* group deleted → the audience is captured *before* the rows are deleted, then notified.

`GET /site-chat/:groupId` deliberately does **not** broadcast anything (the old
reload-loop bug, see the comment in the route).

## Client subscription (supabase-js v2)

```js
// once, after login — Realtime needs the user's access token for private channels
supabase.realtime.setAuth(accessToken);

// personal topic: list/unread reconciliation + incoming calls
const me = supabase.channel(`user:${user.id}`, { config: { private: true } })
  .on('broadcast', { event: 'chat:changed' }, ({ payload }) => reconcile(payload.groupId))
  .on('broadcast', { event: 'call:signal' },  ({ payload }) => onCallSignal(payload))
  .subscribe();

// per open thread: append rows live
const thread = supabase.channel(`chat:group:${groupId}`, { config: { private: true } })
  .on('broadcast', { event: 'message' },         ({ payload }) => appendMsg(payload))
  .on('broadcast', { event: 'message_deleted' }, ({ payload }) => removeMsg(payload.id))
  .on('broadcast', { event: 'group_deleted' },   ()            => closeThread())
  .subscribe();
```

Mapping from the old `socket.on(...)` handlers in `client/src/pages/SiteChat.jsx`:

| Old | New |
|---|---|
| `socket.on('message', row)` | `chat:group:<id>` / `message` |
| `socket.on('changed', {groupId})` | `user:<me>` / `chat:changed` |
| `socket.on('group_deleted', {groupId})` | `chat:group:<id>` / `group_deleted` (also arrives as `chat:changed`) |
| `socket.emit('join', gid)` | subscribe to `chat:group:<gid>` when a thread opens; unsubscribe on close |
| `socket.on('connect', …)` (reload on reconnect) | channel status callback → `SUBSCRIBED` after a drop → reload thread |

Channels are private: subscribing requires a valid Supabase access token and an
RLS policy on `realtime.messages` that allows the topic. The policy must permit
`user:<id>` only for that user, and `chat:group:<gid>` only for members (plus
admins for non-DM groups) — i.e. the same predicate as `canAccess()`.

## WebRTC call signalling

Old flow: `socket.emit('call:offer', { to, callId, sdp, video })` → server relayed
to room `u:<to>` as `call:offer` with `{ ..., from, fromName }`.

New flow (`client/src/context/CallContext.jsx` `emit()` should become this call):

```
POST /api/site-chat/calls/signal
{ "toUserId": 42, "type": "offer", "data": { "callId": "...", "sdp": {...}, "video": true } }
→ 200 { "ok": true }
```

`type` may be passed with or without the `call:` prefix (`"call:offer"` is
normalised to `"offer"`); anything outside `offer|answer|ice|reject|end|cancel`
is a 400. The callee receives on `user:<toUserId>`:

```
event: call:signal
payload: { fromUserId: 7, fromName: "Monika", type: "offer", data: { callId, sdp, video } }
```

So the old per-event handlers become one switch on `payload.type`; `from` → `fromUserId`.
ICE servers are unchanged: `GET /site-chat/ice` → `{ iceServers: [...] }` (public
STUN + optional TURN from `app_settings.turn_url/turn_username/turn_password`).

## Behavioural differences vs. the Socket.IO server (deliberate)

1. **No 300 ms coalescing of `changed`.** The old server debounced `changed`
   per group in process memory; Edge Functions are stateless per request, so
   every triggering request sends its own `chat:changed`. The event is
   idempotent ("reconcile"), so the client should keep its own short debounce.
2. **Send rate-limit is per isolate.** 40 msgs / 10 s / user → 429, same
   message text, but the counter lives in one isolate's memory (best-effort
   backpressure, as before across pm2 workers).
3. **Broadcasts are awaited before the HTTP response** so a terminated isolate
   cannot drop them; each adds one HTTP round-trip to Realtime.
4. **`message_deleted`** is a new event (old code only sent `changed`); the
   `chat:changed` still follows it, so an un-updated client keeps working.
5. **Multipart send.** `POST /site-chat/:groupId` also accepts
   `multipart/form-data` with a `file` part; it is stored via
   `storeUpload(file, 'chat')` and becomes `attachment_url` /
   `attachment_name` (falls back to the original filename). The JSON path the
   page uses today (upload via `/upload`, then send the URL) is unchanged.

## REST endpoints (unchanged shapes)

`GET /ice`, `GET /groups[?limit&q&phase&after_last_id&after_name&after_id&mine=1]`,
`GET /unread-count`, `POST /groups`, `POST /dm`, `PUT /:groupId`, `DELETE /:groupId`,
`GET /:groupId[?limit&before]`, `POST /:groupId`, `POST /:groupId/read`,
`GET /:groupId/members`, `POST /:groupId/members`, `DELETE /:groupId/members/:userId`,
`DELETE /:groupId/messages/:msgId`, **new** `POST /calls/signal`.
