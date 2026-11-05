import { EventEmitter } from 'node:events';
import type { DesktopBackend } from './desktop-backend.js';
import { Store } from './store.js';
import { DeliveryError } from './transport.js';
import { turnsOf, orderedEntities } from './timeline.js';
import type { Operation, OperationState } from '../shared/types.js';

export class Operations extends EventEmitter {
  private onState = (id: string, state: any) => this.reconcile(id, state);
  private busy = new Set<string>();
  private release = new Map<string, () => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private desktop: DesktopBackend,
    private store: Store,
  ) {
    super();
    desktop.on('state', this.onState);
  }
  submit(device: string, thread: string, id: string, kind: Operation['kind'], input: string): Operation {
    const { operation, fresh } = this.store.beginOperation(id, device, thread, kind, input);
    if (!fresh) return operation;
    if (this.busy.has(thread)) return this.update(id, 'rejected', null, '此会话有一个控制请求正在确认');
    this.busy.add(thread);
    void this.execute(operation, input);
    return operation;
  }
  private async execute(operation: Operation, input: string): Promise<void> {
    const { id, threadId, kind } = operation;
    try {
      // Creation uses Desktop's app-tools socket, not the anchor's history stream.
      if (kind === 'create') {
        this.update(id, 'dispatching');
        const resultId = await this.desktop.control(threadId, kind, input, id);
        if (resultId) this.store.resultThread(id, resultId);
        this.update(id, 'completed');
        return;
      }
      const release = await this.desktop.acquire(threadId);
      this.release.set(id, release);
      if (kind === 'open') await this.desktop.openThread(threadId);
      const view = await this.desktop.waitForView(threadId);
      if (!view?.synchronized) throw new DeliveryError('桌面会话尚未同步，请先在桌面打开', true);
      this.update(id, 'dispatching');
      const resultId = await this.desktop.control(threadId, kind, input, id);
      const turnId = resultId;
      const current = this.store.operation(id)!;
      if (!['completed', 'interrupted', 'failed'].includes(current.state))
        this.update(
          id,
          kind === 'interrupt' ? 'interrupted' : ['send', 'steer'].includes(kind) ? 'accepted' : 'completed',
          turnId,
        );
      if (!['send', 'steer'].includes(kind)) this.cleanup(id);
    } catch (error) {
      const current = this.store.operation(id)!;
      if (!['completed', 'interrupted', 'failed'].includes(current.state))
        this.update(
          id,
          error instanceof DeliveryError && error.notSent ? 'rejected' : 'uncertain',
          null,
          error instanceof DeliveryError && error.notSent
            ? error.message
            : '结果待确认，请勿重复发送；恢复连接后核对桌面会话',
        );
    } finally {
      this.busy.delete(threadId);
      const state = this.store.operation(id)?.state;
      if (state && ['rejected', 'completed', 'interrupted', 'failed'].includes(state)) this.cleanup(id);
      else if (this.release.has(id)) {
        // Bound background observations. Reopening the chat will reconcile longer runs.
        const timer = setTimeout(() => this.cleanup(id), 30 * 60000);
        timer.unref();
        this.timers.set(id, timer);
      }
    }
  }
  private update(
    id: string,
    state: OperationState,
    turnId: string | null = null,
    error: string | null = null,
  ): Operation {
    const operation = this.store.updateOperation(id, state, turnId, error);
    this.emit('operation', operation);
    return operation;
  }
  private reconcile(threadId: string, state: any): void {
    const turns = turnsOf(state);
    for (const operation of this.store.pending(threadId)) {
      const turn = turns.find(
        (t) =>
          orderedEntities(t.items).some(
            (item) =>
              (item.type === 'userMessage' ||
                (item.type === 'steeringUserMessage' && item.status === 'accepted')) &&
              [item.clientId, item.clientUserMessageId].includes(operation.id),
          ) ||
          t.params?.clientUserMessageId === operation.id ||
          (operation.turnId && (t.turnId ?? t.id) === operation.turnId),
      );
      if (!turn) continue;
      const next: OperationState =
        operation.kind === 'respond' || turn.status === 'completed'
          ? 'completed'
          : turn.status === 'interrupted'
            ? 'interrupted'
            : turn.status === 'failed'
              ? 'failed'
              : 'accepted';
      const turnId = turn.turnId ?? turn.id;
      if (next !== operation.state || turnId !== operation.turnId) this.update(operation.id, next, turnId);
      if (['completed', 'interrupted', 'failed'].includes(next)) this.cleanup(operation.id);
    }
  }
  private cleanup(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.release.get(id)?.();
    this.release.delete(id);
  }
  close(): void {
    this.desktop.off('state', this.onState);
    for (const id of this.release.keys()) this.cleanup(id);
  }
}
