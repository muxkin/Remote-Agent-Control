/** Native protocol diagnostics only; production gateway uses plugin hosts. */
import { readConfig as gatewayConfig } from '../src/server/config.js';
import { nativeConfig } from '../packages/adapter-codex/src/config.js';
export function readConfig() {
  const gateway = gatewayConfig();
  return {
    ...gateway,
    ...nativeConfig(gateway.instances?.find((i) => i.id === 'codex-local')?.config ?? {}, gateway.readOnly),
  };
}
