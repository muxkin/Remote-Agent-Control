# Resource policies, storage and monthly relay limits

The Node/VPS and Cloudflare runtimes share `ResourcePolicyProvider`, `ResourceService` and the encrypted media APIs. Membership names and limits are supplied by Lago. Business code does not branch on tier names or contain membership amounts.

## Initial administrative setup

Deploy the optional [Lago service](../deploy/lago/README.md) and open your administrator console. The initial values are decimal bytes (1 MB = 1,000,000 bytes; 1 GB = 1,000,000,000 bytes):

| Initial plan                 | Attachment space | Relay per calendar month |
| ---------------------------- | ---------------: | -----------------------: |
| 普通用户 (`pocket-ordinary`) |           100 MB |                     1 GB |
| 高级用户 (`pocket-premium`)  |             1 GB |                    10 GB |
| Max (`pocket-max`)           |             5 GB |                   100 GB |

Only the ordinary plan is assigned automatically. Higher tiers are available for the administrator to assign later; there is no checkout or automatic charging. Plans have zero price and serve as entitlement records. The calendar month uses `Asia/Shanghai`.

In Lago, open **Plans → the plan → Entitlements → 存储空间 / 月中转流量 → ⋯ → Edit**. Edit a plan's feature entitlements or a customer's subscription overrides:

- `storage.max_bytes`: attachment space, integer bytes.
- `relay.max_bytes`: monthly relay allowance, integer bytes.
- `relay.time_zone`: IANA calendar timezone.

The application reads the active subscription's effective entitlements, including overrides. Policies refresh within 60 seconds on the next resource operation. Existing subscriptions may retain their plan version when a plan is edited: apply changes to existing subscriptions in Lago, or use subscription overrides, and check the application's refreshed values. Keep the monthly timezone stable during a billing period; changing it selects a different calendar ledger.

`deploy/lago/resource-plans.json` and `configure-resources.py` bootstrap initial records only. Re-running the script does not overwrite existing entitlements. New user IDs are provisioned lazily on the first resource operation as `instance:uid`. A terminated/cancelled subscription is never automatically reinstated. More than one active subscription fails closed rather than guessing a tier.

## Enabling an instance

Configure these server-side values in the Node environment or Cloudflare Worker bindings:

```text
POCKET_LAGO_URL=https://billing-api.example.com
POCKET_LAGO_DEFAULT_PLAN=pocket-ordinary
POCKET_RESOURCE_INSTANCE=unique-instance-name
POCKET_LAGO_API_KEY=<server-side secret>
```

Never place the API key in frontend assets or commit it. Cloudflare uses Wrangler secrets; Node uses its private environment. The instance name is stable and isolates different installations' user IDs.

An installation without a configured provider remains self-hosted without membership quotas. Its resource page still permits download and cleanup. Enable the provider independently for each installation; deployment platform does not select a membership policy. Existing application UIDs, account vaults and keys are preserved. Logto account integration is a separate concern.

If Lago is unavailable, a valid cached policy remains usable for up to 60 seconds. After expiry, new uploads and relay frames fail closed with a temporary error. Reading messages, decrypting/downloading existing files and manual cleanup remain available. No stale quota is reused indefinitely.

## Space and manual cleanup

Attachment space counts original encrypted file payloads (including encryption tags), saved stickers and avatars owned by the account and its Agents. Shared physical objects count once within that billing owner. Text messages, encrypted account metadata, database overhead and generated previews are outside this attachment allowance. The existing protocol's per-file upload size remains independent of membership.

Uploads reserve space in a database transaction before awaiting object storage. If space is insufficient, the new upload returns HTTP 413; existing files are preserved. A downgrade below current occupancy also blocks new uploads without deleting existing data.

The account settings page provides:

- **一键下载（解密）**: downloads and decrypts in the client, verifies authentication and plaintext length, then creates ZIP parts up to approximately 128 MiB each. No plaintext or keys are uploaded to the service. A failure report lists files that could not be decrypted/read, such as Agent-private files for which the current client lacks keys. These are not exported as misleading plaintext. Multiple downloads may require browser permission; check the saved archives before cleanup.
- **一键清理**: after confirmation, clears the selected existing attachments, stickers and avatars, including the owner's Agents. Files uploaded after the selection are excluded. Sent attachments become unavailable; message text, signed encrypted envelopes, account keys and the monthly traffic counter remain intact.

Cleanup first commits logical removal. R2/external-object deletion is durable and retried after storage failures. Shared objects survive while another live reference exists. Node external adapters must implement `remove` when resource enforcement is enabled. This is not automatic deletion based on quotas.

## Monthly relay accounting

Current transport enforcement covers the application's existing **WSS encrypted binary payloads**, counted once in each direction (upload plus download). The internal multiplexing header, WebSocket/IP overhead, text signalling, direct WebRTC traffic and HTTP attachment transfers are excluded. This is an application allowance, not a byte-for-byte reproduction of a provider invoice. TURN is not integrated and is not claimed to be metered by this implementation.

A client must exchange its authenticated application session for a short-lived, one-use relay grant bound to host, route and lane. The server persists counters atomically, across reconnects, process restarts and Durable Object hibernation. No client-reported byte counter is trusted. A revoked login session also revokes relay use.

Frames exceeding the remaining allowance are rejected before forwarding and the affected client closes with an explanation; other clients on the shared Gateway connection remain available. Traffic already admitted is not refunded if delivery subsequently fails. The next calendar month starts a new counter; deleting files never restores consumed traffic. Direct connections already established can continue, but establishing a new direct connection may need the relay's signalling path.

## Verification

`test/resources.test.ts` covers provider changes/outage behavior, aggregate Agent ownership, atomic usage, calendar/DST boundaries, revoked sessions, Node WebSocket enforcement, shared-object garbage collection, client decryption/export and signed messages after cleanup. `test/cloudflare/resources.test.ts` exercises native Worker HTTP policy reads, the Worker/DO/R2 runtime, account-bound WebSocket grants and usage across hibernation. The deployment verification script exercises temporary feature, plan and subscription records, then removes them; run it against your own installation before enabling resource enforcement.
