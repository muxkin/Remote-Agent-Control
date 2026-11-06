# DSH Web adapter 1.0.0

Connects to an **already running** DSH Web through its external-client authentication, HTTP and multiplexed WebSocket APIs. Client-only DSH dependencies are pinned to `0.2.1-rc.5`. No Agent startup entry is imported.

Configuration keys: `url`, `token`, optional diagnostic `version`. Use host-side `secrets: { token: "DSH_TOKEN" }` to resolve an environment variable for this instance only. The token is a DSH Web access token, not a model API key. Loopback is the default recommendation; remote addresses must be explicitly configured.

Supports native sessions, event recovery, commands, permissions, presets, goals, plan interactions, models, attachment receipts and ZIP export. Unknown interactions remain with the original product. Command IDs and event positions persist in the instance's private state; uncertain writes are never automatically replayed.

Install a release tarball with the gateway's `adapter install` command; the same package can serve multiple independently upgraded instances. Native product version changes do not disable controls. Contract tests live in this package's source `test/` directory.
