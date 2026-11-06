import { EventEmitter } from 'node:events';
import { connectorFor, type VerifiedPipe } from './connector.js';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FrameReader } from './framing.js';
import type { CodexConfig as Config } from './config.js';
import { platformRuntime } from '../../../src/server/platform.js';

import { DeliveryError } from '../../../src/server/delivery-error.js';
export { DeliveryError } from '../../../src/server/delivery-error.js';
export interface RpcTransport extends EventEmitter {
  connected: boolean;
  connect(): Promise<void>;
  request(method: string, params: unknown, version?: number, target?: string, timeout?: number): Promise<any>;
  broadcast(method: string, params: unknown, version: number, target: string): void;
  close(): void;
}
export class DesktopTransport extends EventEmitter implements RpcTransport {
  connected = false;
  private child: VerifiedPipe | null = null;
  private clientId = 'pocket-uninitialized';
  private pending = new Map<
    string,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(private config: Config) {
    super();
  }
  async connect(): Promise<void> {
    if (this.child) throw new Error('Transport already started');
    const child = connectorFor(this.config).pipe(this.config, this.config.socketPath);
    this.child = child;
    const reader = new FrameReader();
    let reason = 'Desktop IPC disconnected';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      try {
        reader.push(data, (message) => this.receive(message));
      } catch {
        reason = 'Invalid or oversized Desktop IPC message';
        child.kill();
      }
    });
    child.stdin.on('error', () => {
      reason = 'Desktop IPC write failed';
      child.kill();
    });
    child.on('error', () => {
      reason = 'Cannot start local socket verifier';
    });
    child.on('close', () => {
      if (this.child === child) {
        this.child = null;
        this.connected = false;
      }
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DeliveryError(reason));
      }
      this.pending.clear();
      this.emit('disconnect', reason);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Socket verification timed out'));
          child.kill();
        }, 6000);
        const fail = () => {
          clearTimeout(timer);
          reject(new Error(reason));
        };
        child.once('error', fail);
        child.once('close', fail);
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 4096) {
            reason = 'Invalid verifier output';
            child.kill();
            return;
          }
          const lines = stderr.split('\n');
          stderr = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value.type === 'ready') {
                clearTimeout(timer);
                child.off('error', fail);
                child.off('close', fail);
                this.connected = true;
                resolve();
              } else if (value.type === 'error') reason = `Socket verification failed: ${value.error}`;
            } catch {
              reason = 'Invalid verifier output';
              child.kill();
            }
          }
        });
      });
      const initialized = await this.request('initialize', { clientType: 'codex-pocket-remote' });
      if (typeof initialized.result?.clientId !== 'string') throw new Error('Invalid initialize response');
      this.clientId = initialized.result.clientId;
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  private send(value: unknown): void {
    if (!this.connected || !this.child?.stdin.writable)
      throw new DeliveryError('Desktop is not connected', true);
    if (this.child.stdin.writableLength > 1024 * 1024) throw new DeliveryError('Desktop IPC is busy', true);
    this.child.stdin.write(encodeFrame(value));
  }
  request(method: string, params: unknown, version = 0, target?: string, timeout = 5000): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DeliveryError('Desktop response timed out; delivery is uncertain'));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          method,
          params,
          version,
          targetClientId: target,
          timeoutMs: timeout - 250,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  broadcast(method: string, params: unknown, version: number, target: string): void {
    this.send({
      type: 'broadcast',
      sourceClientId: this.clientId,
      targetClientIds: [target],
      method,
      params,
      version,
    });
  }
  private receive(message: any): void {
    if (message.type === 'response') {
      const p = this.pending.get(message.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.requestId);
      if (message.resultType === 'success') p.resolve(message);
      else {
        const error = typeof message.error === 'string' ? message.error : 'Desktop request failed';
        // Only routing failures prove non-delivery. A handler error can occur after submission.
        p.reject(
          new DeliveryError(
            error,
            ['no-client-found', 'request-version-mismatch', 'no-handler-for-request'].includes(error),
          ),
        );
      }
    } else if (message.type === 'client-discovery-request') {
      this.send({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false },
      });
    } else if (message.type === 'broadcast') this.emit('broadcast', message);
  }
  close(): void {
    this.connected = false;
    this.child?.kill();
  }
}
