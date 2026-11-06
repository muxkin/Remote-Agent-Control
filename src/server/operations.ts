import { commandInput } from './backends/commands.js';
import { EventEmitter } from 'node:events';
import type { AgentBackend } from './backends/types.js';
import { Store } from './store.js';
import { DeliveryError } from './delivery-error.js';
import type { OperationObservation } from './backends/types.js';
import { DEFAULT_BACKEND } from '../shared/backends.js';
import type { Operation, OperationState } from '../shared/types.js';

export class Operations extends EventEmitter {
  private onState = (id: string, state: OperationObservation[]) => this.reconcile(id, state);
  private onCreated = (requestId: string, conversationId: string) => {
    const operation = this.store.operation(requestId, undefined, this.backendId);
    if (operation?.kind === 'create' && operation.state === 'dispatching') {
      this.store.resultThread(requestId, conversationId, this.backendId);
      this.update(requestId, 'dispatching');
    }
  };
  private busy = new Set<string>();
  private release = new Map<string, () => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private desktop: AgentBackend,
    private store: Store,
    private backendId = DEFAULT_BACKEND,
  ) {
    super();
    desktop.on('observations', this.onState);
    desktop.on('created', this.onCreated);
  }
  submit(device: string, thread: string, id: string, kind: Operation['kind'], input: string): Operation {
    const { operation, fresh } = this.store.beginOperation(id, device, thread, kind, input, this.backendId);
    if (!fresh) return operation;
    if (this.busy.has(thread)) return this.update(id, 'rejected', null, '此会话有一个控制请求正在确认');
    this.busy.add(thread);
    void this.execute(operation, input);
    return operation;
  }
  private async execute(operation: Operation, input: string): Promise<void> {
    const { id, threadId, kind } = operation;
    try {
      // Creation is an adapter operation; it needs no existing conversation subscription.
      if (kind === 'create') {
        this.update(id, 'dispatching');
        const resultId = await this.desktop.execute(threadId, commandInput(kind, input), id);
        if (resultId) this.store.resultThread(id, resultId, this.backendId);
        this.update(id, 'completed');
        return;
      }
      const release = await this.desktop.acquire(threadId);
      this.release.set(id, release);
      if (kind === 'open') await this.desktop.openThread(threadId);
      const view = await this.desktop.waitForView(threadId);
      if (!view?.synchronized) throw new DeliveryError('会话尚未同步，请先检查原实例', true);
      this.update(id, 'dispatching');
      const resultId = await this.desktop.execute(threadId, commandInput(kind, input), id);
      const turnId = resultId;
      const current = this.store.operation(id, undefined, this.backendId)!;
      if (!['completed', 'interrupted', 'failed'].includes(current.state))
        this.update(
          id,
          kind === 'interrupt' ? 'interrupted' : ['send', 'steer'].includes(kind) ? 'accepted' : 'completed',
          turnId,
        );
      if (!['send', 'steer'].includes(kind)) this.cleanup(id);
    } catch (error) {
      const current = this.store.operation(id, undefined, this.backendId)!;
      if (!['completed', 'interrupted', 'failed'].includes(current.state))
        this.update(
          id,
          error instanceof DeliveryError && error.outcome === 'failed'
            ? 'failed'
            : error instanceof DeliveryError && error.notSent && !current.resultThreadId
              ? 'rejected'
              : 'uncertain',
          null,
          error instanceof DeliveryError && (error.notSent || error.outcome === 'failed')
            ? error.message
            : '结果待确认，请勿重复发送；恢复连接后核对原实例会话',
        );
    } finally {
      this.busy.delete(threadId);
      const state = this.store.operation(id, undefined, this.backendId)?.state;
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
    const operation = this.store.updateOperation(id, state, turnId, error, this.backendId);
    this.emit('operation', operation);
    return operation;
  }
  private reconcile(threadId: string, state: OperationObservation[]): void {
    for (const operation of this.store.pending(threadId, this.backendId)) {
      const turn = state.findLast(
        (t) => t.requestIds.includes(operation.id) || (operation.turnId && t.turnId === operation.turnId),
      );
      if (!turn) continue;
      const next: OperationState = operation.kind === 'respond' ? 'completed' : turn.state;
      const turnId = turn.turnId;
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
    this.desktop.off('observations', this.onState);
    this.desktop.off('created', this.onCreated);
    for (const id of this.release.keys()) this.cleanup(id);
  }
}
