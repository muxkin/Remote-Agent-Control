import { codexObservations } from '../packages/adapter-codex/src/observations.js';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { Operations } from '../src/server/operations.js';
import type { AgentBackend } from '../src/server/backends/types.js';
import { Store } from '../src/server/store.js';
import { fixtureConfig, THREAD, state } from './helpers.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it.each(['accepted', 'rejected'])(
  'reconciles an unconfirmed async reply only from %s native steering',
  (status) => {
    const config = fixtureConfig();
    const desktop = new EventEmitter() as AgentBackend;
    const store = new Store(config.stateDir);
    const operations = new Operations(desktop, store);
    cleanup.push(() => {
      operations.close();
      store.close();
      rmSync(config.desktopRoot, { recursive: true, force: true });
    });
    store.beginOperation('reply-id', 'device', THREAD, 'respond', '{}');
    store.updateOperation('reply-id', 'uncertain', null, 'waiting');
    const snapshot = state();
    snapshot.turnHistory.history.entitiesByKey.one.items.push({
      type: 'steeringUserMessage',
      clientUserMessageId: 'reply-id',
      status,
    });
    desktop.emit('observations', THREAD, codexObservations(snapshot));
    expect(store.operation('reply-id')?.state).toBe(status === 'accepted' ? 'completed' : 'uncertain');
  },
);
