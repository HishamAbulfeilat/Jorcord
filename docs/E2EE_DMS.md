# End-to-end encrypted 1:1 DMs ("secret chats")

Opt-in, per conversation, one-to-one only. A normal DM is unchanged: it is **not** end-to-end encrypted (the server operator can read it, search it and preview its links). A secret chat is a second, separate conversation with the same person (`channels.encrypted = true`, `dm_key` ends in `:e2ee`), started from a profile menu ("Start Secret Chat"). Voice and video calls have their own, separate encryption path (LiveKit/DAVE-style); nothing here changes that.

Status: implemented in the web client (`apps/web/src/lib/e2ee`, `components/chat/SecretChat.tsx`) and the server (`services/e2ee.ts`, `routes/e2ee.ts`, migration 085). Wrappers that embed the web client get it with it (untested there); there is no separate native implementation.

## What the server can and cannot see

| Server sees | Server does not see |
| --- | --- |
| who talks to whom, when, how often, how large each message is (to a 64-byte bucket), reactions, pins, deletes, read state | message text |
| every device's **public** key and label | any private key (generated non-extractable in the browser, never sent) |
| the ciphertext envelope and which device ids it is wrapped for | whether a given envelope is real ciphertext (it checks the shape, not the content) |

For a secret chat the server also: never unfurls links, never parses mentions, does not index it for search (and filters it out of channel search and "search all DMs"), refuses edits, saving for later, reminders, scheduled sends, forwards, attachments, stickers, embeds, polls and component payloads, and puts only "Sent an encrypted message" in push notifications. AutoMod does not apply (it never applied to DMs). Because it cannot read them, **the server cannot moderate or report-review secret-chat content**: "Report message" is a server-moderation feature and DMs have no moderator queue.

## Protocol (v1)

Primitives are WebCrypto only: ECDH P-256, HKDF-SHA-256, AES-256-GCM. No third-party crypto code.

1. **Device identity.** Each device generates one ECDH P-256 key pair. The private key is `extractable: false` and stored in IndexedDB (structured clone of the `CryptoKey`; its bytes are not readable by script). The public key (65-byte uncompressed point, base64url) is published with `POST /users/@me/e2ee/devices`; the server validates that it is a real point on the curve. Up to 10 active devices per account.
2. **Sending.** For each message the sender: draws a fresh AES-256-GCM message key; pads the plaintext to a multiple of 64 bytes with a length prefix; encrypts it with AAD `msg|channelId|authorUserId|senderDeviceId`; draws a fresh **ephemeral** ECDH key `E`; then, for **every active device of the recipient and of the sender's own account** `R`, derives a wrap key = HKDF-SHA-256( ECDH(E, R) ‖ ECDH(senderDeviceIdentity, R) ; salt `jorcord-e2ee-v1`; info `wrap|channelId|senderDevice|R|E` ) and AES-GCM-wraps the message key with it.
3. **Envelope.** `content = "jc-e2ee1:" + base64url(JSON{v:1, from, epk, iv, ct, keys:{deviceId:{iv, wk}}})`, at most 24 000 characters (plaintext capped at 4 000 characters and 6 000 UTF-8 bytes so it always fits).
4. **Receiving.** A device finds its own entry in `keys`, recomputes the same two ECDH results with its private key, unwraps, decrypts. Failure at any step (wrong channel or author, tampered bytes, forged wrap, unknown sender device, not a recipient) shows "could not be opened", never partial plaintext.

Why two ECDH results: the ephemeral one gives the sender-side forward secrecy of the wrap key; the static one **authenticates the sender**. Only the holder of the sending device's private key (or the recipient) can produce a wrap that opens, so the server, which knows every public key, cannot forge a message "from" someone or splice a message into another chat. This authentication is repudiable (the recipient could also have produced it), as in Signal-style deniability.

### Server-side checks (`assertEncryptedPayload`)

The envelope must parse; `from` must be an **active** device of the author; every wrap must target an active device of a participant; every participant must have at least one wrap. This catches client bugs that would strand a recipient and stops plaintext from being stored in a secret chat. It does not and cannot verify the encryption.

### Trust: safety numbers and key-change warnings

- A **safety number** (60 digits in 12 groups) is derived from the fingerprints (SHA-256 of the public key) of all active devices of both people. Both sides see the same number; reading it out over a trusted channel proves no one (server included) is in the middle. Per-device fingerprints are shown too.
- The client **pins** the other person's devices on first contact (trust on first use). Afterwards, a **new device or a replaced key** for a known device id blocks sending in that chat until the user reviews the safety number and chooses "Accept new keys"; a revoked device alone is harmless. "Mark as verified" records that you compared the number.
- The server pushes `E2EE_DEVICES_UPDATE {userId}` to both people's sessions when a device is added or revoked so open chats re-check immediately.
- Revoked devices stay queryable (`GET /channels/:id/e2ee/devices?includeRevoked=true`) so old messages from them still verify; they can neither send nor be wrapped for any more.

## API

`POST /users/@me/e2ee/devices {publicKey, label?}` (201 new, 200 same key again, 409 `E2EE_DEVICE_REVOKED`, 400 `E2EE_DEVICE_LIMIT`; 10/hour) · `GET /users/@me/e2ee/devices` · `DELETE /users/@me/e2ee/devices/:id` · `GET /channels/:id/e2ee/devices[?includeRevoked=true]` (participants of a secret chat only) · `POST /users/@me/channels {recipientIds:[one], encrypted:true}` (400 for groups) · `Channel.encrypted` · gateway `E2EE_DEVICES_UPDATE`. Message errors: `E2EE_REQUIRED`, `E2EE_BAD_DEVICE`, `E2EE_UNKNOWN_DEVICE`, `E2EE_MISSING_RECIPIENT`, `E2EE_TOO_LARGE`, `E2EE_UNSUPPORTED`.

## Limits and honest caveats

- **Multi-device = per-device wraps.** A device only reads messages that were wrapped for it. A device you add **later cannot read earlier messages**, and a new device of the other person cannot either. There is no history sync between devices.
- **Lost device = lost history.** Keys exist only in that browser profile. Clearing site data, a reinstall, or losing every device makes the history unreadable for good; the server cannot recover it. A browser that cannot persist keys (private window, blocked storage) shows a warning and loses history on close.
- **Revoking a device** stops it receiving new messages; it still holds whatever it already decrypted and its key remains able to read anything already wrapped for it.
- **No group E2EE**, and none in servers/channels. 1:1 only.
- **No attachments, link previews, search, edits, stickers, polls, reminders, scheduled messages or forwarding** in secret chats. (Reactions work; the emoji is visible to the server.)
- **Metadata is not hidden.** Participants, timing, message sizes (bucketed), the existence of the chat, reactions, pins and read receipts are all visible to the server.
- **Forward secrecy is partial.** Each message uses a fresh ephemeral key and message key, but there is no ratchet: someone who later steals a device's long-term private key (and has recorded the ciphertext) can read every message ever wrapped for that device. Revoke and re-create devices if one is compromised.
- **Trust is only as good as the verification.** Without comparing safety numbers, a malicious server could add a device for the recipient *before* first contact and the TOFU pin would accept it. After first contact, additions are surfaced and block sending until reviewed.
- **The web client is delivered by the server you are talking to.** A malicious or compromised server operator can serve modified JavaScript that leaks plaintext or keys. This is inherent to browser E2EE and is only mitigated by the desktop/mobile wrappers shipping a fixed client, or by self-hosting.
- **Endpoints are not protected.** Malware or a person with access to an unlocked device sees decrypted messages (they are decrypted into memory when shown and never written to disk by Jorcord; the browser's own caches and OS notifications are outside its control — notifications show "Sent an encrypted message" only).
- **Push** payloads and the desktop notifications contain no content.
- **Abuse handling.** Because the server cannot read secret chats, abuse in them can only be handled by blocking the person (works as usual); there is no server-side evidence for moderators.
- The cryptographic design has been reviewed only by the authors, not by an independent audit. Treat it as a strong improvement over plaintext DMs, not as a replacement for Signal for high-risk users.

## Tests

`apps/web/src/lib/e2ee/crypto.test.ts` (round trips, multi-device, tamper/replay/forgery, size limits, non-extractable keys, safety number and key-change logic), `service.test.ts` (TOFU pinning, blocking on change, accept flow, revoked sender), `components/chat/SecretChat.test.tsx` (UI), `apps/server/test/e2ee-dms.test.ts` (device keys, envelope validation, no unfurl/search/edit/save/schedule/forward, normal DMs unchanged).
