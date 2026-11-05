# Device protocol v2

Three entrypoints share the existing TypeScript repository: `src/web/main.tsx` (PWA), `src/server/main.ts` (desktop host), and `src/server/relay-main.ts` (cloud edge). The desktop exposes no inbound HTTP business listener. The cloud serves static files, `/health`, and `/connect`; `/api/*` is not a business API.

## Authentication and transport

The host and phone each generate an Ed25519 identity. Host identity is stored in a private local file, phone identity in IndexedDB. QR fragments carry `host=<libp2p peer ID>&pair=<one-use secret>`; the page removes the fragment on startup. The host consumes pairing secrets transactionally after five minutes or one use. Their SHA-256 routing tickets do not authenticate business operations.

The edge challenges host connections and verifies signed `(protocol, host ID, lane, random challenge)` proofs. Enrollment is an operator credential, not a public user account. The edge holds host public keys, expiring routing tickets, connection state, and limits. Route deletion prevents new joins; the host closes revoked active sessions and checks authorization on every request. No chat content or file key is sent in signaling or routing frames.

Each path has `control` and `bulk` lanes. `@libp2p/noise` performs authenticated encryption with a version/lane-bound prologue; the phone pins the QR host identity and the host pins registered phone identities. There is no separate homemade encryption handshake or full libp2p network stack. Every WebRTC and WSS lane has an independent Noise connection. Ciphertext frames are bounded; decrypted packets have a four-byte packet size, four-byte JSON size, JSON envelope, and optional binary payload. Network frames are at most 16 KiB before encryption.

Authenticated `pair`/`authenticate` includes protocol 2 and a logical device `sessionId`. `ready` returns the device binding, replacement routing ticket, desktop capabilities, and ICE configuration. Unsupported protocol versions are rejected. A device session owns subscriptions, not a chat page. WSS establishes first; an authenticated `offer`/`candidate` exchange establishes WebRTC in parallel, with Trickle ICE. There is no TURN. An interrupted WSS connection does not close an authenticated direct channel. Failed paths reconnect independently and subscriptions resume from client checkpoints.

Request envelope `id` identifies one RPC attempt. A mutating business body's `requestId` identifies the durable operation across paths/reconnections. They are intentionally separate from `fileId`, `sessionId`, and `threadId`. The UI preserves operation IDs, queries uncertain results, and does not silently replay writes. The subscription key is the `(sessionId, threadId)` pair; watch/unwatch only changes subscriptions.

`src/shared/rpc.ts` is the finite business method allowlist. `GatewayCore` validates/distributes all methods identically on both paths. No caller-selected desktop RPC method, socket path, HTTP destination, or filesystem proxy exists. Legacy v1 HTTP transport fixtures are confined to `test/legacy/` and are excluded from production builds.

## Synchronization and cache

A subscription sends `epoch`, logical `revision`, and message content hashes. Continuous revisions replay the bounded delta journal; gaps, deletion, truncation, ordering changes, eviction, or a new epoch trigger a selective ordered manifest. The phone applies each update atomically to its view. Server journals retain at most 1,000 entries, 8 MiB, or ten minutes per chat, with 64 MiB total journal payload. An unchanged body is omitted from recovery. Read-only list/detail RPCs also support conditional content hashes.

IndexedDB contains device identities/bindings separately from cached content. Cache keys include phone identity, host identity and content identity. Lists and chats render cached content before synchronization; offline controls are disabled. File chunks prefer OPFS, falling back to IndexedDB byte arrays. Content is version checked and writes are coalesced. There is no application-defined disk budget, quota percentage, user size setting, or automatic eviction. Browser write failures leave existing cached data intact and do not interrupt the live session. Clearing content preserves identities, drafts, upload resume journals and uncertain operations. Usage is read only when Settings opens and shown only beside Clear cache. Browser storage may be evicted; reconnection reconstructs it. Draft and operation persistence reuse their existing separately keyed stores.

## Files

`media.describe` reuses exact conversation attachment authorization. `upload.begin` reuses desktop attachment metadata; `file` actions carry `fileId`, `threadId`, block indices and optional bytes. Files are limited to 256 MiB. Each 1 MiB block and the completed upload have SHA-256 validation. Missing-block state survives host restart; complete uploads retain the existing desktop attachment format.

Routing is cache → available direct channel → bounded two-second wait for an in-progress direct attempt → encrypted WSS (≤8 MiB), or encrypted object storage (>8 MiB, when configured), with encrypted WSS fallback. Control and bulk traffic have separate queues. Storage plans group contiguous requested blocks (up to 15 full blocks so ciphertext stays below 16 MiB). Media requests can ask for only the blocks needed by a Range. Original names, content hashes, block manifests, keys and grants travel inside Noise.

Object storage receives random object keys, `application/octet-stream`, and independently authenticated AES-256-GCM ciphertext. Each file version has a fresh key and nonce prefix; the block index forms the unique nonce suffix. AAD binds file ID, version, index and plaintext length. Modified source files require a new manifest/key. The adapter receives ciphertext sizes and optional expiry metadata; uploads use existing adapter upload grants. Objects are removed after successful consumption and expiry cleanup retries locally. Operators must also configure provider-side expiry within 24 hours for abandoned objects while the host is offline.

The existing image/file components use a common content provider. Small files become validated local Blob URLs. A Service Worker handles opaque `/local-files/<capability>` URLs, serves local Range responses, and requests decrypted blocks from the owning page. These URLs never fetch a plaintext cloud route. Media requires its owning page to remain open; reopening the attachment creates a new capability.

## Platform and trust boundaries

`DesktopBackend` declares projects, history-view access, subscriptions, controls and capabilities. `PlatformRuntime` isolates installation discovery, private-file permissions, verified IPC subprocesses, app-tools paths and desktop launching. The Linux implementation is verified against the repository's desktop compatibility baseline. Unknown versions remain read-only. Windows/macOS implementations require real protocol/peer verification; replacing a socket type alone is insufficient.

Endpoints and the static application release chain are trusted. Relay/object storage are untrusted for confidentiality/integrity; endpoint cryptographic identity is pinned. This does not conceal network addresses, timing, byte counts, or protect against a compromised release serving malicious client JavaScript. Revocation cannot retrieve previously downloaded content.

Metrics contain byte counts, cache hits, direct setup time, fallback reasons and resync counts, without body/name/key values. Node/browser acceptance reports record observed behavior, not inferred savings from a green direct indicator.
