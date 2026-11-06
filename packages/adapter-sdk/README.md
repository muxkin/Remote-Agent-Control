# Agent Remote Adapter SDK 1

A typed contract for connecting to **existing** Agent products. A gateway runs one auxiliary Node host per configured instance. Export `createAdapter: AdapterFactory`; it receives only `id`, `name`, `stateDirectory`, `readOnly` and that instance's resolved `config`.

Implement `AgentBackend` and its history interface. `start()` connects; `stop()` disconnects. Neither may start or terminate the native Agent. Emit normalized `thread`, `observations`, `created` and `status` events. Do not emit native wire envelopes. Optional methods are explicitly negotiated with the host. Synchronous views/status are cached by the gateway; remote reads are asynchronous.

Write operations receive a stable request ID. Use native deduplication where available. Throw `DeliveryError(message, true)` only when nothing was sent. If delivery cannot be confirmed, throw with `notSent=false`. Never retry uncertain non-idempotent writes. Emit `created(requestId, conversationId)` as soon as a partially created conversation is known. Approval IDs, cancellation and native revision checks remain the adapter's responsibility.

Package metadata must contain `agentAdapter: { sdk: 1, entry, stateVersion, product, name, presentation }`. Presentation is declarative data: creation rules, plan semantics, file-reference/export availability and native-menu commands. Public capabilities determine availability. New interactions beyond the existing SDK require a deliberate protocol/UI extension; browser JavaScript and arbitrary upstream RPC are not supported.

`stateVersion` is the compatibility contract of the plugin's private on-disk data. Change it for an incompatible migration. The supervisor refuses automatic upgrade/rollback across different state versions. Process isolation contains failures but is **not** a security sandbox for untrusted packages.

See the repository's `docs/ADAPTER_PLUGINS.md` and `test/fixtures/adapter` for a complete third-product fixture.
