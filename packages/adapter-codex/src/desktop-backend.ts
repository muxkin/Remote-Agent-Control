import type { GatewayStatus, ThreadView, Message, Operation } from '../../../src/shared/types.js';
import type { DesktopProject } from './app-tools.js';
/** Desktop semantics, not OS transports. Additional platforms must declare their verified capabilities. */
export interface DesktopBackend {
  readonly capabilities: {
    platform: string;
    protocolVerified: boolean;
    files: boolean;
    controls: boolean;
    creation: boolean;
  };
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  status(): GatewayStatus;
  acquire(id: string): Promise<() => void>;
  view(id: string): ThreadView | null;
  waitForView(id: string, timeout?: number): Promise<ThreadView | null>;
  projects(id: string): Promise<DesktopProject[]>;
  disabledPlugins(id: string): string[];
  openThread(id: string): Promise<void>;
  control(id: string, kind: Operation['kind'], input: string, requestId: string): Promise<string | null>;
  inlineMedia(id: string, reference: string): string | null;
  fullMessage(id: string, messageId: string): Message | null;
}
